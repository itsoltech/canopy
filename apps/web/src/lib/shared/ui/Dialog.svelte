<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "./IconButton.svelte";
  import { exitDuration } from "./motion.ts";
  import SheetHandle from "./SheetHandle.svelte";
  import { windowModal } from "./window-modal.ts";

  /**
   * Modal dialog on the native `<dialog>` (focus trap, Escape, top layer for free).
   * Opens and closes with the bindable `open`; a bottom sheet on phones (drag its handle down to close),
   * centred from `sm`. Scales in and out (motion.css `t-modal`); content stays, inert, until the exit ends.
   * Focus starts on the first `[data-autofocus]` element inside, else on the close button.
   * `size="lg"`: wider from `sm`, for forms with lists (e.g. a provider profile's variables).
   * `size="output"`: 880px terminal viewer; `fullscreen`: fills the phone screen.
   * `dismissible={false}` prevents user dismissal while the caller finishes an async save.
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
  }: { open?: boolean; title: string; description?: string; size?: "md" | "lg" | "output"; fullscreen?: boolean; bare?: boolean; dismissible?: boolean; onkeydown?: ((event: KeyboardEvent) => void) | undefined; class?: ClassValue; children: Snippet } = $props();

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
  oncancel={(event) => { if (!dismissible) event.preventDefault(); }}
  onclose={() => {
    if (!open) return;
    open = false;
    exit();
  }}
  onclick={(event) => {
    if (dismissible && event.target === dialog) open = false; // click on the backdrop
  }}
  data-sheet
  inert={closing || undefined}
  class={[
    "t-modal m-0 mt-auto max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-2xl bg-white p-0 text-zinc-950 shadow-xl ring-1 ring-zinc-950/10 backdrop:bg-zinc-950/40 sm:m-auto sm:rounded-2xl dark:bg-zinc-950 dark:text-white dark:shadow-none dark:ring-white/10 dark:backdrop:bg-black/60",
    size === "output" ? "sm:max-w-[55rem]" : size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg",
    fullscreen && "max-sm:mt-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none",
    className,
  ]}
>
  <SheetHandle onclose={() => { if (dismissible) open = false; }} class="absolute inset-x-0 top-0 sm:hidden" />
  {#if bare}
    <h2 id="{id}-title" class="sr-only">{title}</h2>
    {#if open || closing}{@render children()}{/if}
  {:else}
  <div class="p-5 pb-[max(--spacing(5),env(safe-area-inset-bottom))] sm:p-6">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h2 id="{id}-title" class="text-lg/7 font-semibold text-balance">{title}</h2>
        {#if description}<p id="{id}-description" class="mt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{description}</p>{/if}
      </div>
      <IconButton icon="x-mark" label="Close" size="sm" class="-m-1" disabled={!dismissible} onclick={() => (open = false)} />
    </div>
    <div class="mt-5">
      {#if open || closing}{@render children()}{/if}
    </div>
  </div>
  {/if}
</dialog>
