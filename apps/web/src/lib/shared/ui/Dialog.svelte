<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { provideDensity } from "./density.ts";
  import IconButton from "./IconButton.svelte";
  import { exitDuration } from "./motion.ts";
  import SheetHandle from "./SheetHandle.svelte";
  import { windowModal } from "./window-modal.ts";
  import { backdropDismiss } from "./backdrop.ts";

  /**
   * Modal dialog on the native `<dialog>` (focus trap, Escape, top layer for free).
   * Opens and closes with the bindable `open`; a bottom sheet on phones (drag its handle down to close),
   * centred from `sm`. Scales in and out (motion.css `t-modal`); content stays, inert, until the exit ends.
   * Focus starts on the first `[data-autofocus]` element inside, else on the close button.
   * `size="lg"`: wider from `sm`, for forms with lists (e.g. a provider profile's variables).
   * `size="output"`: 880px terminal viewer; `fullscreen`: fills the phone screen.
   * `dismissible={false}` prevents user dismissal while the caller finishes an async save.
   * Its content uses standard controls (docs/ui-scale.md), also when it opens from a menu or the sidebar.
   */
  let {
    open = $bindable(false),
    title,
    description,
    size = "md",
    fullscreen = false,
    sheet = false,
    bare = false,
    stickyHeader = false,
    dismissible = true,
    onkeydown,
    class: className,
    children,
    footer,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    size?: "md" | "lg" | "output";
    fullscreen?: boolean;
    /** Keep the bottom-sheet placement at larger widths too. */
    sheet?: boolean;
    bare?: boolean;
    /** Keep the heading and close control together above scrolling content. */
    stickyHeader?: boolean;
    dismissible?: boolean;
    onkeydown?: ((event: KeyboardEvent) => void) | undefined;
    class?: ClassValue;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  provideDensity("standard");

  let dialog = $state<HTMLDialogElement>();
  const id = $props.id();
  let closing = $state(false);
  let closed: ReturnType<typeof setTimeout> | undefined;

  function exit() {
    if (!dialog) return;
    closing = true;
    clearTimeout(closed);
    // After `[open]` went away: the closing rule's duration.
    closed = setTimeout(() => (closing = false), exitDuration(dialog));
  }

  $effect(() => () => clearTimeout(closed));

  $effect(() => {
    if (!dialog) return;

    if (open && !dialog.open) {
      clearTimeout(closed);
      closing = false;
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }

    if (!open && dialog.open) {
      dialog.close();
      exit();
    }
  });
</script>

{#snippet handle()}
  <SheetHandle
    onclose={() => {
      if (dismissible) open = false;
    }}
    class={["absolute inset-x-0 top-0", !sheet && "sm:hidden"]}
  />
{/snippet}

{#snippet closeButton()}
  <span class="absolute top-4 right-4 rounded-md bg-surface sm:top-5 sm:right-5">
    <IconButton icon="x-mark" label="Close" size="sm" disabled={!dismissible} onclick={() => (open = false)} />
  </span>
{/snippet}

<dialog
  use:windowModal
  bind:this={dialog}
  {onkeydown}
  aria-labelledby="{id}-title"
  aria-describedby={description ? `${id}-description` : undefined}
  oncancel={(event) => {
    if (!dismissible) event.preventDefault();
  }}
  onclose={() => {
    if (!open) return;
    open = false;
    exit();
  }}
  {...backdropDismiss(() => {
    if (dismissible) open = false;
  })}
  data-sheet={sheet ? "force" : ""}
  inert={closing || undefined}
  class={[
    "density-standard t-modal top-(--window-safe-top) m-0 mt-auto max-h-[min(90dvh,var(--window-safe-height))] w-full max-w-none min-w-0 scroll-stable overflow-x-hidden overflow-y-auto rounded-t-2xl bg-surface p-0 text-ink shadow-xl ring-1 ring-divider backdrop:bg-zinc-950/40 dark:shadow-none dark:backdrop:bg-black/60",
    sheet ? "mx-auto sm:max-w-2xl" : "sm:m-auto sm:rounded-2xl",
    !sheet && (size === "output" ? "sm:max-w-[55rem]" : size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg"),
    fullscreen && "max-sm:mt-0 max-sm:h-(--window-safe-height) max-sm:max-h-(--window-safe-height) max-sm:rounded-none",
    className,
  ]}
>
  {#if bare || !stickyHeader}{@render handle()}{/if}
  {#if bare}
    <h2 id="{id}-title" class="sr-only">{title}</h2>
    {#if open || closing}{@render children()}{/if}
  {:else}
    <div class={footer ? "flex min-h-full flex-col" : undefined}>
      {#if !stickyHeader}
        <div class="sticky top-0 z-10 h-0">{@render closeButton()}</div>
      {/if}
      <div
        class={[
          "min-w-0 pb-[max(--spacing(5),env(safe-area-inset-bottom))] wrap-anywhere",
          !stickyHeader && "p-5 sm:p-6",
          footer && "flex-1",
        ]}
      >
        <div class={stickyHeader ? "sticky top-0 z-10 bg-surface px-5 pt-5 pb-1 sm:px-6 sm:pt-6" : undefined}>
          {#if stickyHeader}
            {@render handle()}
            {@render closeButton()}
          {/if}
          <h2 id="{id}-title" class="min-w-0 pr-8 text-lg/7 font-semibold text-balance">{title}</h2>
        </div>
        {#if description}
          <div class={stickyHeader ? "px-5 sm:px-6" : "mt-1"}>
            <p id="{id}-description" class="pr-8 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
              {description}
            </p>
          </div>
        {/if}
        <div class={["mt-5 min-w-0", stickyHeader && "px-5 sm:px-6 sm:pb-1"]}>
          {#if open || closing}{@render children()}{/if}
        </div>
      </div>
      {#if footer}<div
          class="sticky bottom-0 z-10 border-t border-divider bg-surface px-5 pt-3 pb-[max(--spacing(3),env(safe-area-inset-bottom))] sm:px-6"
        >
          {@render footer()}
        </div>{/if}
    </div>
  {/if}
</dialog>
