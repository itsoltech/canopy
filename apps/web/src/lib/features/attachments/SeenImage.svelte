<script lang="ts">
  import type { BlobRef } from "@open-agents/contracts";
  import { formatSize } from "@open-agents/domain";
  import type { ClassValue } from "svelte/elements";
  import ZoomableImage from "./ZoomableImage.svelte";

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
    class: className,
  }: { threadId: string; blob: BlobRef; name: string; width?: number; height?: number; class?: ClassValue } = $props();
  const src = $derived(`/api/threads/${encodeURIComponent(threadId)}/blobs/${blob.sha256}`);
  let failed = $state(false);
</script>

{#if failed}
  <p class={["text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>The preview is not available ({formatSize(blob.sizeBytes)}, {blob.mimeType}).</p>
{:else}
  <ZoomableImage
    {src}
    {name}
    {width}
    {height}
    detail={width && height ? `${width}×${height} as the model saw it` : ""}
    download="{src}?download"
    class={["rounded-lg", className]}
    imageClass="max-h-64 rounded-lg object-contain"
    onerror={() => (failed = true)}
  />
{/if}
