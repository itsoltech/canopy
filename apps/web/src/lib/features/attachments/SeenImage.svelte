<script lang="ts">
  import type { BlobRef } from "@open-agents/contracts";
  import { formatSize } from "@open-agents/domain";
  import Lightbox from "./Lightbox.svelte";

  /**
   * An image the agent looked at, in its transcript item: the preview the worker uploaded (what the model saw),
   * read through the thread; tap for the full preview.
   */
  let {
    threadId,
    blob,
    name,
    width = 0,
    height = 0,
  }: { threadId: string; blob: BlobRef; name: string; width?: number; height?: number } = $props();
  const src = $derived(`/api/threads/${encodeURIComponent(threadId)}/blobs/${blob.sha256}`);
  let open = $state(false);
  let failed = $state(false);
</script>

{#if failed}
  <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">The preview is not available ({formatSize(blob.sizeBytes)}, {blob.mimeType}).</p>
{:else}
  <button type="button" class="group block max-w-full overflow-hidden rounded-lg focus-ring" aria-label="Open {name}" onclick={() => (open = true)}>
    <img
      {src}
      alt={name}
      width={width || undefined}
      height={height || undefined}
      loading="lazy"
      class="max-h-64 w-auto max-w-full rounded-lg bg-zinc-100 object-contain outline-1 -outline-offset-1 outline-zinc-950/10 group-hover:opacity-90 dark:bg-white/5 dark:outline-white/10"
      onerror={() => (failed = true)}
    />
  </button>
  <Lightbox bind:open {src} {name} detail={width && height ? `${width}×${height} as the model saw it` : ""} download="{src}?download" />
{/if}
