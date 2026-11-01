<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { goalLook } from "#lib/features/goals/goals.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { textTones } from "#lib/shared/ui/tone.ts";

  /**
   * Compact marks of a thread in lists: its goal (flag in the goal's status colour) and the background
   * tasks still running (bolt with their number). Nothing when it has neither.
   */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const goal = $derived(thread.goalStatus ? goalLook(thread.goalStatus) : undefined);
  const tasks = $derived(thread.backgroundTasks);
  const tasksLabel = $derived(`${tasks} running in the background`);
</script>

{#if goal || tasks > 0}
  <span class={["flex shrink-0 items-center gap-1.5 text-sm/5 tabular-nums sm:text-xs/5", className]}>
    {#if tasks > 0}
      <span class="flex items-center gap-0.5 text-sky-700 dark:text-sky-400" {@attach tooltip(tasksLabel)}>
        <Icon name="bolt" class="size-3.5" />{tasks}<span class="sr-only"> {tasks === 1 ? "task" : "tasks"} running in the background</span>
      </span>
    {/if}
    {#if goal}
      <span class={["flex items-center", textTones[goal.tone]]} {@attach tooltip(`Goal: ${goal.label.toLowerCase()}`)}>
        <Icon name="flag" class="size-3.5" label="Goal: {goal.label.toLowerCase()}" />
      </span>
    {/if}
  </span>
{/if}
