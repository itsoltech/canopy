<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { TaskState } from "@canopy/domain/task-list";

  /**
   * A task's state, 16px: an empty ring (pending), an arc (in progress; it spins while `live`) and a green disc
   * whose check draws itself when the task is done (motion.css `t-task-mark`). Labelled for screen readers.
   */
  let { status, live = false, class: className }: { status: TaskState; live?: boolean; class?: ClassValue } = $props();

  const LABELS: Record<TaskState, string> = { pending: "Pending", in_progress: "In progress", completed: "Done" };
</script>

<span
  class={["t-task-mark size-4 shrink-0", className]}
  data-state={status}
  data-live={live || undefined}
  role="img"
  aria-label={LABELS[status]}
>
  <svg viewBox="0 0 16 16" fill="none" class="t-task-track size-4" aria-hidden="true">
    <circle
      cx="8"
      cy="8"
      r="6"
      stroke-width="1.5"
      class={status === "in_progress"
        ? "stroke-sky-600/25 dark:stroke-sky-400/30"
        : "stroke-zinc-950/25 dark:stroke-white/25"}
    />
  </svg>
  <svg viewBox="0 0 16 16" fill="none" class="t-task-arc size-4" aria-hidden="true">
    <path d="M14 8a6 6 0 0 0-6-6" stroke-width="2" stroke-linecap="round" class="stroke-sky-600 dark:stroke-sky-400" />
  </svg>
  <svg viewBox="0 0 16 16" class="t-task-fill size-4" aria-hidden="true">
    <circle cx="8" cy="8" r="7" class="fill-emerald-600 dark:fill-emerald-500" />
  </svg>
  <svg viewBox="0 0 16 16" fill="none" class="size-4" aria-hidden="true">
    <path
      d="M5.1 8.3 7.1 10.3 10.9 6.2"
      pathLength="1"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="t-task-check stroke-white"
    />
  </svg>
</span>
