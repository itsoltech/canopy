<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { loadItemContent } from "./lazy-content.ts";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { formatBytes } from "#lib/shared/format.ts";

  let {
    reference,
    threadId,
    auto = false,
    active = true,
    signal,
    subject = "output",
    class: className = "",
  }: {
    reference: ui.ThreadSyncContent;
    threadId: string;
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
    const requested = attempt;

    if (!active || (!auto && requested === 0)) return;
    const abort = new AbortController();

    void load(signal ? AbortSignal.any([signal, abort.signal]) : abort.signal);

    return () => abort.abort();
  });

  async function load(signal: AbortSignal) {
    loading = true;
    error = "";

    try {
      await loadItemContent(threadId, reference, signal);
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
