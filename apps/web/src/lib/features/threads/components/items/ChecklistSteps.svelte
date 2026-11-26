<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { taskState } from "@canopy/domain/task-list";
  import TaskMark from "../../tasks/TaskMark.svelte";

  /** Steps with their state (any provider spelling, see taskState): done ones struck through, the current one bold. */
  let { steps, class: className }: { steps: readonly { text: string; status: string }[]; class?: ClassValue } =
    $props();
</script>

<ol role="list" class={["grid gap-1.5 text-base/6 sm:text-sm/6", className]}>
  {#each steps as step, index (index)}
    <li class="flex gap-2.5">
      <span class="flex h-lh shrink-0 items-center"><TaskMark status={taskState(step.status)} /></span>
      <span
        class={taskState(step.status) === "completed"
          ? "text-zinc-500 line-through decoration-zinc-400/60 dark:text-zinc-400"
          : taskState(step.status) === "in_progress"
            ? "font-medium text-zinc-950 dark:text-white"
            : "text-zinc-700 dark:text-zinc-300"}>{step.text}</span
      >
    </li>
  {/each}
</ol>
