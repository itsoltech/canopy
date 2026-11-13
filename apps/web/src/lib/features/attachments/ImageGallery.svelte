<script lang="ts">
  import type { ImageGallery } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { observeActivity } from "#lib/shared/activity.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import GalleryTile from "./GalleryTile.svelte";
  import GalleryLightbox from "./GalleryLightbox.svelte";

  let { gallery, class: className }: { gallery: ImageGallery; class?: ClassValue } = $props();
  let visible = $state(false);
  let expanded = $state(false);
  let selected = $state(0);
  let open = $state(false);
  const images = $derived(expanded ? gallery.images : gallery.images.slice(0, 6));
  const number = new Intl.NumberFormat();
</script>

<div
  class={["grid max-w-3xl min-w-0 gap-2", className]}
  data-quote-skip
  {@attach (element) =>
    observeActivity(element, (active) => {
      visible = active;
    })}
>
  {#if gallery.caption}<p class="text-base/7 wrap-anywhere text-zinc-800 sm:text-sm/6 dark:text-zinc-200">
      {gallery.caption}
    </p>{/if}
  <ul role="list" aria-label="Images from the agent" class="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
    {#each images as image, index (image.attachmentId)}
      <li class="min-w-0">
        <GalleryTile
          {image}
          {visible}
          onclick={() => {
            selected = index;
            open = true;
          }}
        />
      </li>
    {/each}
  </ul>
  {#if gallery.images.length > 6}
    <div>
      <Button variant="ghost" size="sm" onclick={() => (expanded = !expanded)}
        >{expanded ? "Show fewer images" : `Show all ${number.format(gallery.images.length)}`}</Button
      >
    </div>
  {/if}
  <GalleryLightbox images={gallery.images} bind:selected bind:open />
</div>
