<script lang="ts">
  import "./sidebar-drag.css";
  import type { SidebarOrder } from "./sidebar-order.svelte.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { ClassValue } from "svelte/elements";

  let { ordering, class: className }: { ordering: SidebarOrder; class?: ClassValue } = $props();
  const pinned = $derived(ordering.settings.sidebar.pinnedThreadIds.includes(ordering.dragging));
  const showZone = $derived(Boolean(ordering.dragging) && (ordering.custom || !pinned));
</script>

<div class={["pointer-events-none sticky top-0 z-20 h-0", className]}>
  <p role="status" class="sr-only">{ordering.message}</p>
  <div
    class="sidebar-pin-zone"
    data-sidebar-pin-zone={showZone || undefined}
    data-active={ordering.pinTarget || undefined}
    aria-hidden="true"
  >
    <div
      class="sidebar-pin-label flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-center text-sm font-medium"
    >
      <Icon name="star" size="sm" />
      {#if pinned}
        {ordering.pinTarget ? "Release to move to top" : "Move to top of Pinned"}
      {:else}
        {ordering.pinTarget ? "Release to pin" : "Drop here to pin"}
      {/if}
    </div>
  </div>
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
      “{ordering.unpin?.thread.title}” stays in the inbox.
    </p>
    <div class="flex justify-end gap-2">
      <Button data-autofocus onclick={() => (ordering.unpin = undefined)}>Cancel</Button>
      <Button variant="primary" onclick={() => void ordering.confirmUnpin()}>Unpin thread</Button>
    </div>
  </div>
</Dialog>
