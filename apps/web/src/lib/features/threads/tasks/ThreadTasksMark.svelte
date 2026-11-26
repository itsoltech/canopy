<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { threadTasksLabel, unfinishedThreadTasks } from "@canopy/domain/task-list";
  import TaskProgressMark from "./TaskProgressMark.svelte";

  /**
   * A thread's unfinished task list in lists: the progress ring and "2/5", with the task in progress on hover.
   */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const tasks = $derived(unfinishedThreadTasks(thread));
</script>

{#if tasks}
  {@const label = threadTasksLabel(tasks)}
  <span class={["flex shrink-0 items-center gap-1 tabular-nums", className]} {@attach tooltip(label)}>
    <TaskProgressMark completed={tasks.completed} total={tasks.total} size="sm" />
    <span aria-hidden="true">{tasks.completed}/{tasks.total}</span>
    <span class="sr-only">{label}</span>
  </span>
{/if}
