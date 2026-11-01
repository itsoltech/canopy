<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ThreadRow from "#lib/features/threads/components/ThreadRow.svelte";
  import { treeActivity } from "#lib/features/threads/activity.ts";
  import { threadForest } from "#lib/features/threads/thread-tree.ts";

  /** A project's threads: main threads (latest activity first) with their side threads nested below. */
  let { threads }: { threads: readonly ui.Thread[] } = $props();
  const overview = useOverview();
  const forest = $derived(threadForest(threads).sort((a, b) => Number(treeActivity([b.main, ...b.sides]) - treeActivity([a.main, ...a.sides]))));
  const meta = (thread: ui.Thread) => `${overview.worker(thread.workerId)?.name ?? "Unknown worker"} · ${thread.cwd}`;
</script>

{#if forest.length === 0}
  <p class="px-2 py-1.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">No threads yet.</p>
{:else}
  <ul role="list" class="grid gap-0.5">
    {#each forest as tree (tree.main.id)}
      <li>
        <ThreadRow thread={tree.main} meta={meta(tree.main)} />
        {#if tree.sides.length > 0}
          <ul role="list" aria-label="Side threads of {tree.main.title}" class="ml-[0.6875rem] grid gap-0.5 border-l border-zinc-950/10 pl-2 dark:border-white/10">
            {#each tree.sides as side (side.id)}<li><ThreadRow thread={side} /></li>{/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
