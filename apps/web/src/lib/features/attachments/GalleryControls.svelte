<script lang="ts">
  import type { GalleryImage } from "@canopy/contracts";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";

  let {
    images,
    selected = $bindable(0),
    lightbox = false,
  }: {
    images: readonly GalleryImage[];
    selected?: number;
    lightbox?: boolean;
  } = $props();

  const image = $derived(images[selected]);
  const pair = $derived(image?.pair ? images.filter((i) => i.pair === image?.pair) : []);
  const comparison = $derived(pair.length === 2);

  // Keep the Before/After switch's space whenever the gallery has a pair, so moving between images
  // never reflows the controls.
  const pairs = $derived(images.some((i) => i.pair));
  const number = new Intl.NumberFormat();

  function move(direction: number) {
    selected = (selected + direction + images.length) % images.length;
  }

  function choose(value: string) {
    const index = images.findIndex((i) => i.pair === image?.pair && i.side === value);

    if (index >= 0) selected = index;
  }
</script>

<div class="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
  <div class="flex shrink-0 items-center gap-2">
    <button
      type="button"
      aria-label="Previous image"
      onclick={() => move(-1)}
      class={[
        "relative min-h-12 rounded-md px-2 py-2 focus-ring sm:min-h-8",
        lightbox ? "hover:bg-white/10" : "hover:bg-zinc-950/5 dark:hover:bg-white/10",
      ]}>Previous</button
    >
    <p class="min-w-12 text-center tabular-nums" role="status">
      <span class:sr-only={lightbox}>Image </span>{number.format(selected + 1)} / {number.format(images.length)}
    </p>
    <button
      type="button"
      aria-label="Next image"
      onclick={() => move(1)}
      class={[
        "relative min-h-12 rounded-md px-2 py-2 focus-ring sm:min-h-8",
        lightbox ? "hover:bg-white/10" : "hover:bg-zinc-950/5 dark:hover:bg-white/10",
      ]}>Next</button
    >
  </div>
  {#if pairs}
    <div
      inert={!comparison}
      class:invisible={!comparison}
      class="rounded-lg bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-white [&_button]:min-h-12 sm:[&_button]:min-h-8"
    >
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
