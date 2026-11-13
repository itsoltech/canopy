<script lang="ts">
  import type { SidebarOrder } from "./sidebar-order.svelte.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { ClassValue } from "svelte/elements";

  let { ordering, class: className }: { ordering: SidebarOrder; class?: ClassValue } = $props();
</script>

<div class={["sticky top-0 z-20 h-0", className]}>
  <p role="status" class="sr-only">{ordering.message}</p>
  {#if ordering.dragging}
    <div
      data-sidebar-pin-zone
      class="pointer-events-none rounded-lg border-2 border-dashed bg-panel px-3 py-2 text-center text-base sm:text-sm {ordering.pinTarget
        ? 'border-brand-500 text-brand-700 dark:text-brand-300'
        : 'border-zinc-400 text-zinc-600 dark:border-zinc-600 dark:text-zinc-300'}"
    >
      {ordering.pinTarget ? "Release to pin" : "Drop here to pin"}
    </div>
  {/if}
</div>
<Dialog
  title="Unpin thread?"
  bind:open={
    () => !!ordering.unpin,
    (open) => {
      if (!open) ordering.unpin = undefined;
    }
  }
>
  <div class="grid gap-4">
    <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
      Remove “{ordering.unpin?.thread.title}” from Pinned? The thread stays in the inbox.
    </p>
    <div class="flex justify-end gap-2">
      <Button data-autofocus onclick={() => (ordering.unpin = undefined)}>Cancel</Button>
      <Button variant="primary" onclick={() => void ordering.confirmUnpin()}>Unpin thread</Button>
    </div>
  </div>
</Dialog>
