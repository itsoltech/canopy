<script lang="ts">
  import { taskListSummary, type TaskList } from "@canopy/domain/task-list";
  import type { ClassValue } from "svelte/elements";
  import { swap } from "#lib/shared/ui/motion.ts";
  import ComposerPanelBody from "../components/ComposerPanelBody.svelte";
  import ComposerPanelHeader from "../components/ComposerPanelHeader.svelte";
  import TaskMark from "./TaskMark.svelte";
  import TaskProgressMark from "./TaskProgressMark.svelte";

  /**
   * The agent's task list above the composer (stacked with goal, subagents and queue): one line with the
   * progress ring, the task in progress and "3 of 7 done", opening into the whole checklist. Each task's mark
   * morphs from its arc to a check as the agent finishes it (motion.css `t-task-mark`). `live` lets the
   * current task's arc spin while the thread works.
   */
  let {
    tasks,
    live = false,
    compact = false,
    class: className,
  }: { tasks: TaskList; live?: boolean; compact?: boolean; class?: ClassValue } = $props();

  const id = $props.id();
  let open = $state(false);

  // As with the other panels: in the compact composer the list opens on its own and stays open after it expands.
  let peek = $state(false);
  const expanded = $derived(compact ? peek : open);
  let list = $state<HTMLOListElement>();

  $effect.pre(() => {
    if (compact || !peek) return;

    open = true;
    peek = false;
  });

  const summary = $derived(taskListSummary(tasks));
  const headline = $derived(summary.current?.text ?? "All tasks done");

  // Opening a long list shows where the work is, not its top. Only the list's own scroller moves:
  // `scrollIntoView` would also scroll the tray's clipped, still-collapsed wrapper, which then
  // springs back as the tray grows and drags the rows down at the end of the reveal.
  $effect(() => {
    if (!expanded || !list) return;

    const scroller = list.parentElement;
    const current = list.querySelector("[data-current]");

    if (!scroller || !current) return;

    const row = current.getBoundingClientRect();
    const top = row.top - scroller.getBoundingClientRect().top - scroller.clientTop;
    const bottom = top + row.height;

    if (top < 0) scroller.scrollTop += top;
    else if (bottom > scroller.clientHeight) scroller.scrollTop += bottom - scroller.clientHeight;
  });
</script>

<section data-tasks-panel data-keeps-compact aria-labelledby="{id}-label" class={className}>
  <ComposerPanelHeader
    {expanded}
    controls="{id}-list"
    onclick={(wasExpanded) => {
      if (compact) peek = !wasExpanded;
      else open = !wasExpanded;
    }}
  >
    <TaskProgressMark completed={summary.completed} total={summary.total} />
    <span id="{id}-label" class="sr-only">Tasks</span>
    <span class="grid min-w-0 flex-1" aria-live="polite">
      {#key headline}<span
          class={[
            "col-start-1 row-start-1 truncate",
            summary.done ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-800 dark:text-zinc-200",
          ]}
          in:swap>{headline}</span
        >{/key}
    </span>
    <span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400">
      {summary.completed} of {summary.total} done
    </span>
  </ComposerPanelHeader>
  <ComposerPanelBody id="{id}-list" open={expanded}>
    {#if tasks.note}
      <p class="px-3 pt-2 text-sm/5 text-pretty text-zinc-500 sm:text-[0.8125rem]/5 dark:text-zinc-400">
        {tasks.note}
      </p>
    {/if}
    <ol role="list" class="grid py-1" bind:this={list}>
      {#each tasks.steps as step, index (index)}
        <li
          class="flex gap-2.5 px-3 py-1.5 text-sm/5 sm:py-1 sm:text-[0.8125rem]/5"
          data-current={step === summary.current || undefined}
        >
          <span class="flex h-lh shrink-0 items-center"><TaskMark status={step.status} {live} /></span>
          <span
            class={[
              "min-w-0 text-pretty",
              step.status === "completed"
                ? "text-zinc-500 dark:text-zinc-400"
                : step.status === "in_progress"
                  ? "font-medium text-zinc-950 dark:text-white"
                  : "text-zinc-700 dark:text-zinc-300",
            ]}>{step.text}</span
          >
        </li>
      {/each}
    </ol>
  </ComposerPanelBody>
</section>
