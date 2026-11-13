<script lang="ts">
  import type { GalleryImage } from "@canopy/contracts";
  import { observeActivity } from "#lib/shared/activity.ts";
  import AttachmentImage from "./AttachmentImage.svelte";

  let { image, onopen }: { image: GalleryImage; onopen: () => void } = $props();
  let visible = $state(false);
</script>

<span class="my-2 inline-grid w-80 max-w-full align-top" data-quote-skip>
  <span
    class="grid aspect-video overflow-hidden rounded-lg bg-zinc-950/3 dark:bg-white/5"
    {@attach (element) =>
      observeActivity(element, (active) => {
        visible = active;
      })}
  >
    {#if visible && image.hasThumbnail}
      <AttachmentImage
        src="/api/attachments/{encodeURIComponent(image.attachmentId)}?thumbnail"
        entityId={image.attachmentId}
        alt={image.alt}
        class="h-full w-full overflow-hidden text-sm/5"
        imageClass="h-full w-full object-contain"
        {onopen}
      />
    {:else if visible}
      <button type="button" class="rounded-lg focus-ring" onclick={onopen}>Open image</button>
    {/if}
  </span>
</span>
