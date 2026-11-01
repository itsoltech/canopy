<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ThreadRow from "#lib/features/threads/components/ThreadRow.svelte";
  import { threadForest } from "#lib/features/threads/thread-tree.ts";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";

  /** A project's threads: main threads (newest first) with their side threads nested below. */
  let { threads }: { threads: readonly ui.Thread[] } = $props();
  const overview = useOverview();
  const forest = $derived(threadForest(threads).reverse());
  const meta = (thread: ui.Thread) => `${overview.worker(thread.workerId)?.name ?? "Unknown worker"} · ${thread.cwd}`;
</script>

{#if forest.length === 0}
  <EmptyState icon="sparkles" title="No threads yet" description="Start a thread to give an agent a task in one of this project's workspaces." />
{:else}
  <ul role="list" class="grid gap-1 divide-y divide-zinc-950/5 dark:divide-white/5">
    {#each forest as tree (tree.main.id)}
      <li class="pb-1 not-first:pt-1">
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
