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
    bare = false,
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
    bare?: boolean;
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
  data-sheet
  inert={closing || undefined}
  class={[
    "density-standard t-modal top-(--window-safe-top) m-0 mt-auto max-h-[min(90dvh,var(--window-safe-height))] w-full max-w-none min-w-0 scroll-stable overflow-x-hidden overflow-y-auto rounded-t-2xl bg-surface p-0 text-ink shadow-xl ring-1 ring-divider backdrop:bg-zinc-950/40 sm:m-auto sm:rounded-2xl dark:shadow-none dark:backdrop:bg-black/60",
    size === "output" ? "sm:max-w-[55rem]" : size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg",
    fullscreen && "max-sm:mt-0 max-sm:h-(--window-safe-height) max-sm:max-h-(--window-safe-height) max-sm:rounded-none",
    className,
  ]}
>
  <SheetHandle
    onclose={() => {
      if (dismissible) open = false;
    }}
    class="absolute inset-x-0 top-0 sm:hidden"
  />
  {#if bare}
    <h2 id="{id}-title" class="sr-only">{title}</h2>
    {#if open || closing}{@render children()}{/if}
  {:else}
    <div class={footer ? "flex min-h-full flex-col" : undefined}>
      <!-- Zero-height sticky row: the close button stays in the corner while the dialog scrolls. -->
      <div class="sticky top-0 z-10 h-0">
        <span class="absolute top-4 right-4 rounded-md bg-surface sm:top-5 sm:right-5">
          <IconButton icon="x-mark" label="Close" size="sm" disabled={!dismissible} onclick={() => (open = false)} />
        </span>
      </div>
      <div
        class={[
          "min-w-0 p-5 pb-[max(--spacing(5),env(safe-area-inset-bottom))] wrap-anywhere sm:p-6",
          footer && "flex-1",
        ]}
      >
        <div class="pr-8">
          <div class="min-w-0">
            <h2 id="{id}-title" class="text-lg/7 font-semibold text-balance">{title}</h2>
            {#if description}<p
                id="{id}-description"
                class="mt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
              >
                {description}
              </p>{/if}
          </div>
        </div>
        <div class="mt-5 min-w-0">
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
