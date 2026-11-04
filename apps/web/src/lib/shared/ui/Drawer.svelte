<script lang="ts">
  import type { Snippet } from "svelte";
  import IconButton from "./IconButton.svelte";
  import { windowModal } from "./window-modal.ts";

  /** Side panel from the left on the native `<dialog>` (mobile navigation); slides in and out (motion.css `t-drawer`). */
  let { open = $bindable(false), label, children }: { open?: boolean; label: string; children: Snippet } = $props();

  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();

    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  use:windowModal
  bind:this={dialog}
  aria-label={label}
  onclose={() => (open = false)}
  onclick={(event) => {
    if (event.target === dialog) open = false;
  }}
  class="t-drawer top-(--window-safe-top) m-0 h-(--window-safe-height) max-h-none w-full max-w-88 bg-transparent p-0 backdrop:bg-zinc-950/40 dark:backdrop:bg-black/60"
>
  <div
    class="relative flex h-full w-[calc(100%-3.5rem)] max-w-80 flex-col bg-white shadow-xl ring-1 ring-zinc-950/10 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10"
  >
    <div class="absolute top-2.5 -right-12">
      <IconButton icon="x-mark" label="Close menu" variant="secondary" onclick={() => (open = false)} />
    </div>
    {@render children()}
  </div>
</dialog>
