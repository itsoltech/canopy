<script lang="ts">
  import type { GalleryImage } from "@canopy/contracts";
  import AttachmentImage from "./AttachmentImage.svelte";

  let { image, visible, onclick }: { image: GalleryImage; visible: boolean; onclick: () => void } = $props();
  const caption = $derived(image.caption || image.alt || image.name);
  const side = $derived(image.side === "before" ? "Before" : image.side === "after" ? "After" : "");
</script>

<figure class="grid min-w-0 content-start gap-1.5">
  <div class="grid aspect-video w-full min-w-0 overflow-hidden rounded-lg bg-zinc-950/3 dark:bg-white/5">
    {#if visible}
      <AttachmentImage
        src="/api/attachments/{encodeURIComponent(image.attachmentId)}?thumbnail"
        entityId={image.attachmentId}
        alt={image.alt}
        onopen={onclick}
        class="h-full w-full overflow-hidden text-sm/5 sm:text-xs/5"
        imageClass="h-full w-full min-w-0 object-contain outline-1 -outline-offset-1 outline-zinc-950/10 group-hover:opacity-90 dark:outline-white/10"
      />
    {/if}
  </div>
  <figcaption class="grid min-h-12 min-w-0 gap-0.5 text-sm/5 sm:text-xs/5">
    {#if side}<p class="font-medium text-zinc-950 dark:text-white">{side}</p>{/if}
    <p class="line-clamp-2 wrap-anywhere text-zinc-600 dark:text-zinc-400" title={caption}>{caption}</p>
  </figcaption>
</figure>
