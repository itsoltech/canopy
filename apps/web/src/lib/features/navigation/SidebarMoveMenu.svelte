<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { useSidebarOrder, type MoveDirection } from "./sidebar-order.svelte.ts";
  import MenuSub from "#lib/shared/ui/MenuSub.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import type { ClassValue } from "svelte/elements";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const ordering = useSidebarOrder();

  const moves: { value: MoveDirection; label: string }[] = [
    { value: "up", label: "Move up" },
    { value: "down", label: "Move down" },
    { value: "top", label: "Move to top" },
    { value: "bottom", label: "Move to bottom" },
  ];
</script>

{#if ordering?.available(thread)}
  <div class={className}>
    <MenuSub label="Move" icon="arrows-right-left">
      {#each moves as move (move.value)}
        <MenuItem
          disabled={!ordering.canMove(thread, move.value)}
          onselect={() => void ordering.move(thread, move.value)}>{move.label}</MenuItem
        >
      {/each}
    </MenuSub>
  </div>
{/if}
