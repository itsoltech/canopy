<script lang="ts">
  import { create, fromBinary, toJsonString } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { loadThreadItem } from "@canopy/domain/thread-content";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { formatBytes } from "#lib/shared/format.ts";
  import type { Item } from "@canopy/contracts";

  let {
    reference,
    threadId,
    onload,
    auto = false,
    active = true,
    signal,
    subject = "output",
    class: className = "",
  }: {
    reference: ui.ThreadSyncContent;
    threadId: string;
    onload: (item: Item) => void;
    auto?: boolean;
    active?: boolean;
    signal?: AbortSignal;
    subject?: "output" | "message" | "thought" | "summary";
    class?: string;
  } = $props();

  let loading = $state(false);
  let error = $state("");
  let attempt = $state(0);

  $effect(() => {
    if (!active || (!auto && attempt === 0)) return;
    const abort = new AbortController();

    void load(signal ? AbortSignal.any([signal, abort.signal]) : abort.signal);

    return () => abort.abort();
  });

  async function load(signal: AbortSignal) {
    loading = true;
    error = "";

    try {
      const item = await loadThreadItem(
        reference,
        async (offset, length) => {
          const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/content`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
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
        signal,
        threadId,
      );

      if (!signal.aborted) onload(item);
    } catch {
      if (!signal.aborted) error = `Could not load the full ${subject}.`;
    } finally {
      if (!signal.aborted) loading = false;
    }
  }
</script>

{#if active}
  <div data-quote-skip class={`min-h-5 text-sm/5 text-muted sm:text-xs/5 ${className}`}>
    {#if loading || (auto && !error)}
      <span role="status" class="flex items-center gap-1.5"><Spinner class="size-3" />Loading {subject}…</span>
    {:else if error}
      <div class="flex flex-wrap items-center gap-x-2">
        <span role="status">{error}</span>
        <MoreButton expanded={false} onclick={() => attempt++}>Retry</MoreButton>
      </div>
    {:else}
      <MoreButton expanded={false} onclick={() => attempt++}
        >Show full {subject} · {formatBytes(reference.sizeBytes)}</MoreButton
      >
    {/if}
  </div>
{/if}
