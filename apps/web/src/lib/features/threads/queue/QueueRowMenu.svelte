<script lang="ts">
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";

  /**
   * "…" of a queued message (a sheet on phones): edit it in place, move it to either end, and the composer's
   * default while a turn runs — queueing on (Enter queues, Mod+Enter steers) or off (Enter steers). `hints` says
   * what the message runs with instead of the thread's defaults (phones have no room for it in the row).
   */
  let {
    index,
    count,
    hints,
    delivery,
    onedit,
    onmove,
    ondelivery,
  }: {
    index: number;
    count: number;
    hints: readonly string[];
    delivery: "steer" | "queue" | undefined;
    onedit?: (() => void) | undefined;
    onmove: (index: number) => void;
    ondelivery: (delivery: "steer" | "queue") => void;
  } = $props();
</script>

<DropdownMenu label="Queued message actions" placement="top-end" sheet class="w-64">
  {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="More actions" size="sm" {...props} />{/snippet}
  {#if hints.length > 0}
    <p class="px-3.5 pt-2 pb-1 text-sm/5 text-zinc-500 sm:px-3 sm:text-xs/5 dark:text-zinc-400">
      Runs with {hints.join(", ")}
    </p>
  {/if}
  {#if onedit}<MenuItem icon="pencil-square" onselect={onedit}>Edit message</MenuItem>{/if}
  <MenuItem icon="arrow-up" disabled={index === 0} onselect={() => onmove(0)}>Move to top</MenuItem>
  <MenuItem icon="arrow-down" disabled={index === count - 1} onselect={() => onmove(count - 1)}>Move to bottom</MenuItem
  >
  {#if delivery}
    <MenuSeparator />
    {#if delivery === "queue"}
      <MenuItem
        icon="arrow-turn-down-right"
        description="Send messages into the running turn by default."
        onselect={() => ondelivery("steer")}>Turn off queueing</MenuItem
      >
    {:else}
      <MenuItem
        icon="queue-list"
        description="Save new messages for the next turn by default."
        onselect={() => ondelivery("queue")}>Turn on queueing</MenuItem
      >
    {/if}
  {/if}
</DropdownMenu>
