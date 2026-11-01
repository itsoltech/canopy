<script lang="ts">
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import type { BotAction } from "../actions.ts";

  /** Actions given as data (a conversation's or a message's), as the items of a `DropdownMenu`. */
  let { actions }: { actions: readonly BotAction[] } = $props();
</script>

{#each actions as action (action.label)}
  <MenuItem icon={action.icon} disabled={action.disabled} onselect={action.onselect}>{action.label}</MenuItem>
{/each}
