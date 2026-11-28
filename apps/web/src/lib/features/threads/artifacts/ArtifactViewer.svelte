<script lang="ts">
  import type { Item } from "@canopy/contracts";
  import { onMount, tick, type Snippet } from "svelte";
  import PublishedVideoView from "#lib/features/attachments/PublishedVideoView.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import VisualView from "#lib/features/visuals/VisualView.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SheetHandle from "#lib/shared/ui/SheetHandle.svelte";
  import { backdropDismiss } from "#lib/shared/ui/backdrop.ts";
  import { provideDensity } from "#lib/shared/ui/density.ts";
  import { exitDuration } from "#lib/shared/ui/motion.ts";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ArtifactGallery from "./ArtifactGallery.svelte";
  import { artifactDetail, artifactTitle } from "./artifact-meta.ts";

  let {
    items,
    selected,
    threadId,
    onselect,
    onclose,
    onshow,
  }: {
    items: readonly Item[];
    selected: string;
    threadId: string;
    onselect: (itemId: string) => void;
    onclose: () => void;
    onshow: (item: Item) => void;
  } = $props();

  provideDensity("standard");

  const capabilities = useGatewayCapabilities();
  const index = $derived(items.findIndex((entry) => entry.itemId === selected));
  const item = $derived(items[index]);
  const number = new Intl.NumberFormat();
  let open = $state(true);
  let reveal = $state.raw<Item>();
  let dialog: HTMLDialogElement;

  onMount(() => {
    const node = dialog;
    node.showModal();
    node.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();

    return () => node.close();
  });

  $effect(() => {
    if (!item) open = false;
  });

  // Keep the list inert until the exit ends. A fresh row activation can then open its own viewer immediately.
  $effect(() => {
    if (open) return;

    const timer = setTimeout(() => {
      dialog.close();

      if (reveal) onshow(reveal);
      else onclose();
    }, exitDuration(dialog));

    return () => clearTimeout(timer);
  });

  async function move(direction: number) {
    const next = items[index + direction];

    if (!next) return;
    const focused = document.activeElement;
    onselect(next.itemId);
    await tick();

    if (focused instanceof HTMLButtonElement && focused.disabled)
      dialog.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
  }

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    if (
      !(event.target instanceof Element) ||
      !event.target.closest("[data-artifact-navigation]") ||
      event.target.closest(":popover-open")
    )
      return;

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    void move(event.key === "ArrowRight" ? 1 : -1);
  }
</script>

{#snippet heading(title: string, detail: string, actions?: Snippet)}
  <header
    class="sticky top-0 z-10 flex min-h-17 min-w-0 shrink-0 items-center gap-2 border-b border-divider bg-surface py-2 pr-14 pl-4 sm:pl-5"
    data-artifact-navigation
  >
    <div class="min-w-0 flex-1">
      <h3 class="max-h-24 overflow-y-auto text-base/5 font-semibold wrap-anywhere" {title}>{title}</h3>
      <p class="truncate text-sm/5 text-muted sm:text-xs/5" title={detail}>{detail}</p>
    </div>
    {@render actions?.()}
  </header>
{/snippet}

<dialog
  bind:this={dialog}
  use:windowModal
  aria-label={item ? artifactTitle(item) : "Artifact preview"}
  class="density-standard t-modal top-(--window-safe-top) m-0 h-(--window-safe-height) max-h-(--window-safe-height) w-full max-w-none overflow-hidden bg-surface p-0 text-ink shadow-xl ring-1 ring-divider backdrop:bg-zinc-950/40 sm:m-auto sm:h-[min(80dvh,45rem)] sm:max-w-[55rem] sm:rounded-2xl dark:shadow-none dark:backdrop:bg-black/60"
  data-closing={!open || undefined}
  data-sheet=""
  onkeydown={keydown}
  oncancel={(event) => {
    event.preventDefault();
    open = false;
  }}
  {...backdropDismiss(() => (open = false))}
>
  <SheetHandle class="absolute inset-x-0 top-0 sm:hidden" onclose={() => (open = false)} />
  <div inert={!open} class="relative mt-5 flex h-[calc(100%-1.25rem)] min-h-0 flex-col sm:mt-0 sm:h-full">
    <div class="absolute top-4 right-3 z-20 sm:top-5" data-artifact-navigation>
      <IconButton icon="x-mark" label="Close preview" size="sm" data-autofocus onclick={() => (open = false)} />
    </div>
    {#if item}
      {#key item.itemId}
        <div class="preview flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {#if item.content.case === "visual" && capabilities?.supportsMethod("GetVisual") !== false}
            <VisualView visual={item.content.value} {threadId} itemId={item.itemId} onescape={() => (open = false)}>
              {#snippet previewHeader(shown, actions)}
                {@const displayed = { ...item, content: { case: "visual" as const, value: shown } }}
                {@render heading(artifactTitle(displayed), artifactDetail(displayed), actions)}
              {/snippet}
            </VisualView>
          {:else}
            {@render heading(artifactTitle(item), artifactDetail(item))}
            <div
              class={[
                "grid min-w-0 flex-1 place-items-center bg-canvas p-3 sm:p-5",
                item.content.case === "imageGallery" && "min-h-0 grid-rows-[minmax(0,1fr)]",
              ]}
            >
              {#if item.content.case === "imageGallery"}
                <ArtifactGallery gallery={item.content.value} title={artifactTitle(item)} />
              {:else if item.content.case === "publishedVideo"}
                <PublishedVideoView video={item.content.value} showCaption={false} />
              {:else if item.content.case === "visual"}
                <p class="text-sm text-muted">Update Canopy on your gateway to open this visual.</p>
              {/if}
            </div>
          {/if}
        </div>
      {/key}
      <footer
        class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-divider bg-surface px-3 pt-2 pb-[max(--spacing(2),env(safe-area-inset-bottom))] sm:px-4"
        data-artifact-navigation
      >
        <Button
          icon="chat-bubble-left-right"
          size="sm"
          variant="ghost"
          onclick={() => {
            reveal = item;
            open = false;
          }}>Show in thread</Button
        >
        {#if items.length > 1}
          <div class="flex items-center gap-2">
            <p role="status" class="text-sm text-muted tabular-nums sm:text-xs">
              <span class="sr-only">Artifact </span>{number.format(index + 1)} / {number.format(items.length)}<span
                class="sr-only">, {artifactTitle(item)}</span
              >
            </p>
            <IconButton
              icon="chevron-left"
              label="Previous artifact"
              size="sm"
              disabled={index <= 0}
              onclick={() => move(-1)}
            />
            <IconButton
              icon="chevron-right"
              label="Next artifact"
              size="sm"
              disabled={index + 1 >= items.length}
              onclick={() => move(1)}
            />
          </div>
        {/if}
      </footer>
    {/if}
  </div>
</dialog>

<style>
  dialog[open][data-closing],
  dialog[open][data-closing]::backdrop {
    opacity: 0;
    transition-duration: var(--duration-quick);
  }

  dialog[open][data-closing] {
    scale: var(--scale-tiny);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html[data-motion="full"]) .preview {
      transform-origin: center;
      animation: preview-open var(--duration-fast) var(--ease-smooth-out);
    }
  }
  @keyframes preview-open {
    from {
      opacity: 0;
      transform: perspective(900px) scale(var(--scale-small));
    }
    40% {
      transform: perspective(900px) rotateX(var(--rotate-tilt)) rotateY(calc(var(--rotate-tilt) * -0.5));
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>
