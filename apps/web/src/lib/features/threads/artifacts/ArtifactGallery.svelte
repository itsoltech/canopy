<script lang="ts">
  import type { ImageGallery } from "@canopy/contracts";
  import AttachmentImage from "#lib/features/attachments/AttachmentImage.svelte";
  import GalleryLightbox from "#lib/features/attachments/GalleryLightbox.svelte";
  import GalleryControls from "#lib/features/attachments/GalleryControls.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";

  let { gallery, title }: { gallery: ImageGallery; title: string } = $props();
  let selected = $state(0);
  let open = $state(false);
  const image = $derived(gallery.images[selected]);
</script>

{#if image}
  <figure class="grid h-full min-h-0 w-full min-w-0 grid-rows-[minmax(7rem,1fr)_auto] gap-3">
    <div class="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] place-items-center">
      <AttachmentImage
        src="/api/attachments/{encodeURIComponent(image.attachmentId)}"
        entityId={image.attachmentId}
        alt={image.alt || image.name}
        onopen={() => (open = true)}
        class="h-full min-h-0 w-full grid-rows-[minmax(0,1fr)] justify-items-center"
        imageClass="mx-auto max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
    <figcaption class="grid gap-1">
      {#if image.caption && image.caption !== title}<p
          class="max-h-[16dvh] overflow-y-auto text-sm/5 wrap-anywhere text-muted"
        >
          {image.caption}
        </p>{/if}
      <div class="flex items-center gap-2 text-sm/5 sm:text-xs/5">
        <div class="min-w-0 flex-1">
          {#if gallery.images.length > 1}<GalleryControls images={gallery.images} bind:selected />{/if}
        </div>
        <IconButton icon="arrows-pointing-out" label="Open full screen" size="sm" onclick={() => (open = true)} />
      </div>
    </figcaption>
  </figure>
  <GalleryLightbox images={gallery.images} bind:selected bind:open />
{:else}
  <p class="text-sm text-muted">Images unavailable</p>
{/if}
