<script lang="ts">
  import type { GalleryImage } from "@canopy/contracts";
  import { formatSize } from "@canopy/domain";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
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
  const pair = $derived(image?.pair ? images.filter((i) => i.pair === image?.pair) : []);
  const comparison = $derived(pair.length === 2);
  const number = new Intl.NumberFormat();

  function move(direction: number) {
    selected = (selected + direction + images.length) % images.length;
  }

  function choose(value: string) {
    const index = images.findIndex((i) => i.pair === image?.pair && i.side === value);

    if (index >= 0) selected = index;
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
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Previous image"
            onclick={() => move(-1)}
            class="relative min-h-12 rounded-md px-2 py-2 focus-ring hover:bg-white/10 sm:min-h-8">Previous</button
          >
          <p class="min-w-12 text-center tabular-nums" role="status">
            {number.format(selected + 1)} / {number.format(images.length)}
          </p>
          <button
            type="button"
            aria-label="Next image"
            onclick={() => move(1)}
            class="relative min-h-12 rounded-md px-2 py-2 focus-ring hover:bg-white/10 sm:min-h-8">Next</button
          >
        </div>
        {#if comparison}
          <div class="rounded-lg bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-white">
            <SegmentedChoice
              label="Compare images"
              bind:value={() => image?.side ?? "", choose}
              options={[
                { value: "before", label: "Before" },
                { value: "after", label: "After" },
              ]}
            />
          </div>
        {/if}
      </div>
    {/snippet}
  </Lightbox>
{/if}
