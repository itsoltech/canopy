<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";
  import { backdropDismiss } from "#lib/shared/ui/backdrop.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { exitDuration } from "#lib/shared/ui/motion.ts";
  import AttachmentImage from "./AttachmentImage.svelte";
  import VideoPlayer from "./VideoPlayer.svelte";

  /**
   * An image at full size over the page (modal 06: `t-modal` scales in on --duration-fast, out on
   * --duration-quick). Escape, the backdrop or the close button closes it; the download link saves the file.
   */
  let {
    open = $bindable(false),
    src,
    name,
    detail = "",
    download,
    entityId,
    video = false,
    poster,
    alt,
    caption = "",
    controls,
    onNavigate,
  }: {
    open?: boolean;
    src: string;
    name: string;
    detail?: string;
    download?: string | undefined;
    entityId?: string;
    video?: boolean;
    poster?: string | undefined;
    alt?: string;
    caption?: string;
    controls?: Snippet;
    onNavigate?: (direction: number) => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let closing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let zoomed = $state(false);

  $effect(() => () => clearTimeout(timer));

  $effect(() => {
    if (!dialog) return;

    if (open && !dialog.open) {
      zoomed = false;
      clearTimeout(timer);
      closing = false;
      dialog.showModal();
    }

    if (!open && dialog.open) {
      dialog.close();
      closing = true;
      timer = setTimeout(() => (closing = false), exitDuration(dialog));
    }
  });
</script>

<dialog
  use:windowModal
  bind:this={dialog}
  aria-label={name}
  class="t-modal top-(--window-safe-top) m-auto max-h-(--window-safe-height) max-w-[min(96vw,100rem)] overflow-visible bg-transparent p-0 backdrop:bg-zinc-950/80 dark:backdrop:bg-black/85 macos:overflow-y-auto"
  onclose={() => (open = false)}
  onkeydown={(event) => {
    if (!event.defaultPrevented && onNavigate && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      zoomed = false;
      onNavigate(event.key === "ArrowRight" ? 1 : -1);
    }
  }}
  {...backdropDismiss(() => (open = false))}
>
  {#if open || closing}
    <figure class="grid max-h-(--window-safe-height) grid-rows-[minmax(0,1fr)_auto] gap-3">
      <div
        class="max-h-[calc(var(--window-safe-height)-11rem)] max-w-[96vw] scroll-stable overflow-auto rounded-lg sm:max-h-[calc(var(--window-safe-height)-8rem)]"
      >
        {#if video}
          <VideoPlayer {src} {poster} active={open} />
        {:else}
          <AttachmentImage
            {src}
            alt={alt || name}
            {entityId}
            class="min-h-36 rounded-lg bg-zinc-950 text-white"
            imageClass={[
              "mx-auto w-auto rounded-lg object-contain outline-1 -outline-offset-1 outline-white/10",
              zoomed
                ? "max-w-none"
                : "max-h-[calc(var(--window-safe-height)-11rem)] max-w-full sm:max-h-[calc(var(--window-safe-height)-8rem)]",
            ]}
          />
        {/if}
      </div>
      <!-- Its own dark surface: readable over any page, also while the backdrop fades in. -->
      <figcaption
        class="grid max-h-[45vh] min-w-0 gap-2 overflow-auto rounded-xl bg-zinc-950/90 p-3 text-base/6 text-white sm:text-sm/6"
      >
        {@render controls?.()}
        {#if caption}<p class="max-w-prose wrap-anywhere">{caption}</p>{/if}
        <div class="grid min-w-0 gap-2 sm:flex sm:items-center sm:justify-between sm:gap-3">
          <span class="min-w-0">
            <span class="block truncate font-medium">{name}</span>
            {#if detail}<span class="block truncate text-white/60 tabular-nums">{detail}</span>{/if}
          </span>
          <span class="flex shrink-0 items-center justify-end gap-1">
            {#if !video}<button
                type="button"
                aria-pressed={zoomed}
                onclick={() => (zoomed = !zoomed)}
                class="min-h-12 min-w-20 rounded-md px-2 py-1.5 font-medium focus-ring hover:bg-white/10 sm:min-h-8"
                >{zoomed ? "Zoom out" : "Zoom in"}</button
              >
            {/if}
            {#if download}
              <a
                href={download}
                download={name}
                class="relative inline-flex min-h-12 items-center gap-1 rounded-md py-1.5 pr-2.5 pl-2 font-medium text-white focus-ring hover:bg-white/10 sm:min-h-8"
              >
                <Icon name="arrow-down" class="shrink-0 text-white" />Download
              </a>
            {/if}
            <button
              type="button"
              class="relative grid size-9 place-items-center rounded-md focus-ring hover:bg-white/10 sm:size-8"
              aria-label="Close"
              onclick={() => (open = false)}
            >
              <Icon name="x-mark" class="text-white" />
              <TouchTarget />
            </button>
          </span>
        </div>
      </figcaption>
    </figure>
  {/if}
</dialog>
