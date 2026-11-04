<script lang="ts">
  import { ItemStatus, type Item } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { backgroundName, visibleTasks, type BackgroundEntry } from "../background-tasks.ts";
  import BackgroundTaskStatus from "./BackgroundTaskStatus.svelte";
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
  const shown = $derived(visibleTasks(tasks, expanded));
  const id = $props.id();
</script>

{#if tasks.length > 0}
  <section aria-labelledby={id} class={["grid grid-cols-1 p-1.5", className]}>
    <h2 {id} class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Background tasks</h2>
    <ul role="list" class="grid gap-0.5">
      {#each shown as entry (entry.id)}
        {@const task = entry.item.content.value}
        {@const source = items.get(task.sourceItemId)?.content}
        <li class="flex min-w-0 items-center gap-1 rounded-lg pr-1.5">
          <button
            type="button"
            class="grid min-w-0 flex-1 gap-1 rounded-lg px-3 py-2 text-left focus-ring hover:bg-zinc-950/4 dark:hover:bg-white/5"
            onclick={() => onopen(entry.id)}
          >
            <span
              class={[
                "truncate text-sm/6 text-zinc-700 dark:text-zinc-300",
                !task.description && task.command && "font-mono",
              ]}
              title={task.command || task.description}>{backgroundName(task)}</span
            >
            <BackgroundTaskStatus
              {entry}
              exitCode={source?.case === "commandExecution" ? source.value.exitCode : undefined}
            />
          </button>
          {#if entry.item.status === ItemStatus.IN_PROGRESS}<BackgroundTaskStop {threadId} itemId={entry.id} />{/if}
        </li>
      {/each}
    </ul>
    {#if tasks.length > shown.length || expanded}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-left text-sm/5 text-zinc-500 focus-ring hover:text-zinc-950 dark:hover:text-white"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        {expanded ? "Show fewer" : `Show ${tasks.length - shown.length} more`}
      </button>
    {/if}
  </section>
{/if}
