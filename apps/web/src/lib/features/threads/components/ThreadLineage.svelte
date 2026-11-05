<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { groupSideThreads, type ThreadTree } from "../thread-tree.ts";
  import ThreadStatusText from "../ThreadStatusText.svelte";
  import PanelRow from "./PanelRow.svelte";
  import LineageRow from "./LineageRow.svelte";
  import PreviousAgents from "./PreviousAgents.svelte";
  import SubagentLineage from "./SubagentLineage.svelte";

  let {
    tree,
    currentId,
    onnewside,
    class: className,
  }: { tree: ThreadTree; currentId: string; onnewside?: (() => void) | undefined; class?: ClassValue } = $props();

  const sides = $derived(groupSideThreads(tree.sides.filter((thread) => !thread.spawnedByAgent)));
  const agents = $derived(tree.sides.filter((thread) => thread.spawnedByAgent));
  const id = $props.id();
</script>

<section aria-label="Lineage" class={["grid grid-cols-1 px-1.5 pt-1.5", className]}>
  {#if sides.active.length || sides.previous.length || !agents.length || tree.main.id !== currentId}
    <h2 {id} class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Lineage</h2>
    <ul role="list" aria-labelledby={id} class="grid grid-cols-1 gap-0.5">
      <li>
        <PanelRow icon="chat-bubble-left-right" href="/threads/{tree.main.id}" current={tree.main.id === currentId}>
          {tree.main.title}
          {#snippet aside()}<ThreadStatusText thread={tree.main} />{/snippet}
        </PanelRow>
      </li>
      {#each sides.active as thread (thread.id)}
        <li><LineageRow {thread} {currentId} class="pl-6" /></li>
      {/each}
    </ul>
    <PreviousAgents threads={sides.previous} class="pl-3">
      {#snippet row(thread)}<LineageRow {thread} {currentId} previous class="opacity-60" />{/snippet}
    </PreviousAgents>
  {/if}
  <SubagentLineage threads={agents} {currentId} />
  {#if onnewside}
    <PanelRow icon="plus" onclick={onnewside} class="text-zinc-500 dark:text-zinc-400">New side thread</PanelRow>
  {/if}
</section>
