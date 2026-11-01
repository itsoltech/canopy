<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "./IconButton.svelte";

  /**
   * Modal dialog on the native `<dialog>` (focus trap, Escape, top layer for free).
   * Opens and closes with the bindable `open`; a bottom sheet on phones, centred from `sm`.
   * Focus starts on the first `[data-autofocus]` element inside, else on the close button.
   */
  let {
    open = $bindable(false),
    title,
    description,
    class: className,
    children,
  }: { open?: boolean; title: string; description?: string; class?: ClassValue; children: Snippet } = $props();

  let dialog = $state<HTMLDialogElement>();
  const id = $props.id();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="{id}-title"
  aria-describedby={description ? `${id}-description` : undefined}
  onclose={() => (open = false)}
  onclick={(event) => {
    if (event.target === dialog) open = false; // click on the backdrop
  }}
  class={[
    "m-0 mt-auto max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-2xl bg-white p-0 text-zinc-950 shadow-xl ring-1 ring-zinc-950/10 backdrop:bg-zinc-950/40 sm:m-auto sm:max-w-lg sm:rounded-2xl dark:bg-zinc-900 dark:text-white dark:shadow-none dark:ring-white/10 dark:backdrop:bg-black/60",
    className,
  ]}
>
  <div class="p-5 pb-[max(--spacing(5),env(safe-area-inset-bottom))] sm:p-6">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h2 id="{id}-title" class="text-lg/7 font-semibold text-balance">{title}</h2>
        {#if description}<p id="{id}-description" class="mt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{description}</p>{/if}
      </div>
      <IconButton icon="x-mark" label="Close" size="sm" class="-m-1" onclick={() => (open = false)} />
    </div>
    <div class="mt-5">
      {#if open}{@render children()}{/if}
    </div>
  </div>
</dialog>
