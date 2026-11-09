<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Lightbox from "./Lightbox.svelte";
  import type { ui } from "@canopy/contracts";
  import AttachmentPreview from "./AttachmentPreview.svelte";

  /**
   * An image in the chat that opens at full size (Lightbox) when tapped. `src` is what the chat shows (a thumbnail),
   * `full` the image in the lightbox (default: `src`). `onerror`: the image could not be loaded.
   */
  let {
    src,
    full = src,
    name,
    detail = "",
    download,
    width = 0,
    height = 0,
    imageClass,
    class: className,
    onerror,
    file,
  }: {
    src: string;
    full?: string;
    name: string;
    detail?: string;
    download?: string | undefined;
    width?: number;
    height?: number;
    imageClass?: ClassValue;
    class?: ClassValue;
    onerror?: (() => void) | undefined;
    file?: ui.Attachment;
  } = $props();

  let open = $state(false);
  let anchor = $state<HTMLButtonElement>();
</script>

<button
  bind:this={anchor}
  type="button"
  class={["group block max-w-full overflow-hidden focus-ring", className]}
  aria-label="Open {name}"
  onclick={() => (open = true)}
>
  <img
    {src}
    alt={name}
    width={width || undefined}
    height={height || undefined}
    loading="lazy"
    class={[
      "w-auto max-w-full bg-zinc-100 outline-1 -outline-offset-1 outline-zinc-950/10 group-hover:opacity-90 dark:bg-white/5 dark:outline-white/10",
      imageClass,
    ]}
    {onerror}
  />
</button>
{#if file}<AttachmentPreview {file} {anchor} bind:open />
{:else}<Lightbox bind:open src={full} {name} {detail} {download} />{/if}
