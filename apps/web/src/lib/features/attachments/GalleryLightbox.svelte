<script lang="ts">
  import type { GalleryImage } from "@canopy/contracts";
  import { formatSize } from "@canopy/domain";
  import GalleryControls from "./GalleryControls.svelte";
  import Lightbox from "./Lightbox.svelte";

  let {
    images,
    selected = $bindable(0),
    open = $bindable(false),
  }: {
    images: readonly GalleryImage[];
    selected?: number;
    open?: boolean;
  } = $props();

  const image = $derived(images[selected]);

  function move(direction: number) {
    selected = (selected + direction + images.length) % images.length;
  }
</script>

{#if image}
  <Lightbox
    bind:open
    src="/api/attachments/{encodeURIComponent(image.attachmentId)}"
    download="/api/attachments/{encodeURIComponent(image.attachmentId)}?download"
    entityId={image.attachmentId}
    name={image.name}
    alt={image.alt}
    caption={image.caption || image.alt}
    detail="{image.width}×{image.height} · {formatSize(image.sizeBytes)}"
    onNavigate={move}
  >
    {#snippet controls()}
      <GalleryControls {images} bind:selected lightbox />
    {/snippet}
  </Lightbox>
{/if}
