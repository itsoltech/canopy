<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { groupSideThreads } from "#lib/features/threads/thread-tree.ts";
  import PreviousAgents from "#lib/features/threads/components/PreviousAgents.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import SidebarSideThread from "./SidebarSideThread.svelte";

  /** Shared tree layout: children keep their normal rows and archived ones remain in Previous agents. */
  let { sides, title, currentThreadId, class: className }: {
    sides: ReturnType<typeof groupSideThreads>; title: string; currentThreadId?: string | undefined; class?: ClassValue;
  } = $props();
</script>

<div class={["border-l border-zinc-950/10 pl-1.5 dark:border-white/10", className]} transition:expand>
  {#if sides.active.length}
    <ul role="list" aria-label="Side threads of {title}" class="grid grid-cols-1 gap-0.5">
      {#each sides.active as side (side.id)}<li><SidebarSideThread thread={side} current={side.id === currentThreadId} /></li>{/each}
    </ul>
  {/if}
  <PreviousAgents threads={sides.previous}>
    {#snippet row(side)}<SidebarSideThread thread={side} current={side.id === currentThreadId} previous />{/snippet}
  </PreviousAgents>
</div>
