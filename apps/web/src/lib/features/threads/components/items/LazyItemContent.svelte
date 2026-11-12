<script lang="ts">
  import { onDestroy } from "svelte";
  import { create, fromBinary, toJsonString } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { loadThreadItem } from "@canopy/domain/thread-content";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { Item } from "@canopy/contracts";

  let {
    reference,
    threadId,
    onload,
    class: className = "",
  }: {
    reference: ui.ThreadSyncContent;
    threadId: string;
    onload: (item: Item) => void;
    class?: string;
  } = $props();

  let loading = $state(false);
  let error = $state("");
  const abort = new AbortController();

  onDestroy(() => abort.abort());

  async function load() {
    loading = true;
    error = "";

    try {
      const item = await loadThreadItem(
        reference,
        async (offset, length) => {
          const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/content`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: abort.signal,
            body: toJsonString(
              ui.ThreadSyncContentRequestSchema,
              create(ui.ThreadSyncContentRequestSchema, {
                sha256: reference.sha256,
                offset,
                length,
              }),
            ),
          });

          if (!response.ok) throw new Error("Content unavailable");

          return fromBinary(ui.ThreadSyncContentChunkSchema, new Uint8Array(await response.arrayBuffer()));
        },
        abort.signal,
        threadId,
      );

      onload(item);
    } catch {
      if (!abort.signal.aborted) error = "Could not load the full item. Try again.";
    } finally {
      loading = false;
    }
  }
</script>

<div class={`text-copy flex flex-wrap items-center gap-2 py-1 text-muted ${className}`}>
  <Button size="sm" variant="ghost" disabled={loading} onclick={load}>{loading ? "Loading…" : "Load full item"}</Button>
  <p>{error || "Showing a preview."}</p>
</div>
