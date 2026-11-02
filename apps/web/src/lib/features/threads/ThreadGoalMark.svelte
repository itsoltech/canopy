<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { goalLook } from "#lib/features/goals/goals.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { textTones } from "#lib/shared/ui/tone.ts";

  /** A thread's goal in lists: a flag in the goal's status colour; nothing without one. Background tasks: ThreadActivityMark. */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const goal = $derived(thread.goalStatus ? goalLook(thread.goalStatus) : undefined);
</script>

{#if goal}
  <span class={["flex shrink-0 items-center", textTones[goal.tone], className]} {@attach tooltip(`Goal: ${goal.label.toLowerCase()}`)}>
    <Icon name="flag" class="size-3.5" label="Goal: {goal.label.toLowerCase()}" />
  </span>
{/if}
