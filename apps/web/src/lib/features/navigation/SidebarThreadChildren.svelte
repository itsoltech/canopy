<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { groupSideThreads } from "#lib/features/threads/thread-tree.ts";
  import PreviousAgents from "#lib/features/threads/components/PreviousAgents.svelte";
  import { expandTrack } from "#lib/shared/ui/motion.ts";
  import SidebarSideThread from "./SidebarSideThread.svelte";

  /** Shared tree layout: children keep their normal rows and archived ones remain in Previous agents. */
  let {
    sides,
    title,
    currentThreadId,
    snoozed = false,
    class: className,
  }: {
    sides: ReturnType<typeof groupSideThreads>;
    title: string;
    currentThreadId?: string | undefined;
    snoozed?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div class="grid min-w-0 grid-rows-[1fr]" transition:expandTrack>
  <div class="flow-root min-h-0 min-w-0">
    <div class={["border-l border-zinc-950/10 pl-1.5 dark:border-white/10", className]}>
      {#if sides.active.length}
        <ul role="list" aria-label="Side threads of {title}" class="grid grid-cols-1 gap-0.5">
          {#each sides.active as side (side.id)}<li>
              <SidebarSideThread thread={side} current={side.id === currentThreadId} {snoozed} />
            </li>{/each}
        </ul>
      {/if}
      <PreviousAgents threads={sides.previous}>
        {#snippet row(side)}<SidebarSideThread
            thread={side}
            current={side.id === currentThreadId}
            {snoozed}
            previous
          />{/snippet}
      </PreviousAgents>
    </div>
  </div>
</div>
