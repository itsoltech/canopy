<script lang="ts">
  import { ItemStatus, type Item } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { visibleTasks, type BackgroundEntry } from "../background-tasks.ts";
  import BackgroundTaskSummary from "./BackgroundTaskSummary.svelte";
  import BackgroundTaskStop from "./BackgroundTaskStop.svelte";

  let {
    tasks,
    threadId,
    items,
    onopen,
    class: className,
  }: {
    tasks: readonly BackgroundEntry[];
    threadId: string;
    items: ReadonlyMap<string, Item>;
    onopen: (id: string) => void;
    class?: ClassValue;
  } = $props();

  let expanded = $state(false);
  let visibleCount = $state(3);
  let currentThreadId = $state("");
  const runningCount = $derived(tasks.filter((entry) => entry.item.status === ItemStatus.IN_PROGRESS).length);
  const shown = $derived(visibleTasks(tasks, expanded, Math.max(3, visibleCount - runningCount)));
  const id = $props.id();

  $effect(() => {
    if (threadId === currentThreadId) return;
    currentThreadId = threadId;
    expanded = false;
    visibleCount = 3;
  });

  // Finishing a task keeps the rows already shown, so the next section does not jump up.
  $effect(() => {
    if (!expanded) visibleCount = Math.max(visibleCount, shown.length);
  });
</script>

{#if tasks.length > 0}
  <section aria-labelledby={id} class={["grid min-w-0 grid-cols-1 px-1.5 py-1", className]}>
    <h2 {id} class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Background tasks</h2>
    <ul role="list" class="grid min-w-0">
      {#each shown as entry (entry.id)}
        {@const task = entry.item.content.value}
        {@const source = items.get(task.sourceItemId)?.content}
        <li class="flex min-w-0 items-center rounded-lg pr-1">
          <button
            type="button"
            class="min-h-9 min-w-0 flex-1 rounded-lg px-2 py-1 text-left text-base/5 text-zinc-700 focus-ring hover:bg-zinc-950/4 sm:min-h-8 sm:text-sm/5 dark:text-zinc-300 dark:hover:bg-white/5"
            onclick={() => onopen(entry.id)}
          >
            <BackgroundTaskSummary
              {entry}
              exitCode={source?.case === "commandExecution" ? source.value.exitCode : undefined}
            />
          </button>
          <div class="w-8 shrink-0 sm:w-7">
            {#if entry.item.status === ItemStatus.IN_PROGRESS}<BackgroundTaskStop
                {threadId}
                itemId={entry.id}
                compact
              />{/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if tasks.length > shown.length || expanded}
      <button
        type="button"
        class="min-h-9 rounded-lg px-2 py-1 text-left text-sm/5 text-zinc-500 focus-ring hover:text-zinc-950 sm:min-h-8 sm:text-xs/5 dark:text-zinc-400 dark:hover:text-white"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        {expanded ? "Show fewer" : `Show ${tasks.length - shown.length} more`}
      </button>
    {/if}
  </section>
{/if}
