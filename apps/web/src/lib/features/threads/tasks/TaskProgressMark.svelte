<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /**
   * How much of the task list is done, 16px: a ring that fills with each finished task and turns into a green
   * check once all are done (motion.css `t-task-mark`). Decorative: the summary next to it says the same.
   */
  let {
    completed,
    total,
    size = "md",
    class: className,
  }: { completed: number; total: number; size?: "md" | "sm"; class?: ClassValue } = $props();

  const box = $derived(size === "md" ? "size-4" : "size-3.5");

  const done = $derived(total > 0 && completed >= total);
  const share = $derived(total > 0 ? Math.min(completed / total, 1) : 0);
</script>

<span class={["t-task-mark shrink-0", box, className]} data-state={done ? "done" : "pending"} aria-hidden="true">
  <svg viewBox="0 0 16 16" fill="none" class={["t-task-track -rotate-90", box]}>
    <circle cx="8" cy="8" r="6" stroke-width="2" class="stroke-zinc-950/10 dark:stroke-white/15" />
    <circle
      cx="8"
      cy="8"
      r="6"
      stroke-width="2"
      pathLength="1"
      stroke-dasharray="1"
      stroke-dashoffset={1 - share}
      stroke-linecap={share > 0 ? "round" : "butt"}
      class="t-task-progress stroke-emerald-600 dark:stroke-emerald-500"
    />
  </svg>
  <svg viewBox="0 0 16 16" class={["t-task-fill", box]}>
    <circle cx="8" cy="8" r="7" class="fill-emerald-600 dark:fill-emerald-500" />
  </svg>
  <svg viewBox="0 0 16 16" fill="none" class={box}>
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
