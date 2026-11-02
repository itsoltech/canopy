<script lang="ts">
  import { ItemStatus, type Image } from "@open-agents/contracts";
  import SeenImage from "#lib/features/attachments/SeenImage.svelte";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import ItemFrame from "./ItemFrame.svelte";

  /**
   * An image the agent looked at (the platform's view_image, the harness's own image viewer) or generated, with
   * the preview of what the model saw. A view that failed says why (e.g. a path outside the workspace).
   */
  let { image, status }: { image: Image; status: ItemStatus } = $props();
  const directory = useThreadDirectory();
  const label = $derived(image.source === "generated" ? "Generated image" : image.source === "view_image" ? "Viewed image" : "Image");
  const name = $derived(image.path.split(/[/\\]/).pop() || "image");
  const failed = $derived(status === ItemStatus.FAILED || Boolean(image.detail));
</script>

<ItemFrame icon="photo" {status} tone={failed ? "rose" : "neutral"} defaultOpen>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5"><span class="shrink-0">{label}</span><span class="truncate font-mono text-[0.8125rem] text-zinc-950 dark:text-white">{image.path || image.prompt || "generated"}</span></span>
  {/snippet}
  {#if image.prompt}<p class="text-zinc-700 dark:text-zinc-300">{image.prompt}</p>{/if}
  {#if image.blob}
    <SeenImage threadId={directory.currentId} blob={image.blob} {name} width={image.width} height={image.height} />
    {#if image.originalWidth && (image.originalWidth !== image.width || image.originalHeight !== image.height)}
      <p class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">{image.originalWidth}×{image.originalHeight} px, shown to the model at {image.width}×{image.height}.</p>
    {/if}
  {:else if image.detail}
    <p class="text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-400">{image.detail}</p>
  {:else if status !== ItemStatus.IN_PROGRESS}
    <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">No preview of this image.</p>
  {/if}
</ItemFrame>
