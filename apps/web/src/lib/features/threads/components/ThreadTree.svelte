<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ThreadTree } from "../thread-tree.ts";
  import ThreadRow from "./ThreadRow.svelte";

  /** Main thread with its side threads below it (two levels). The current thread is highlighted. */
  let { tree, currentId, class: className }: { tree: ThreadTree; currentId: string; class?: ClassValue } = $props();
</script>

<ul role="list" class={["grid gap-0.5", className]}>
  <li><ThreadRow thread={tree.main} current={tree.main.id === currentId} /></li>
  {#if tree.sides.length > 0}
    <li>
      <ul role="list" aria-label="Side threads of {tree.main.title}" class="ml-[0.6875rem] grid gap-0.5 border-l border-zinc-950/10 pl-2 dark:border-white/10">
        {#each tree.sides as side (side.id)}
          <li><ThreadRow thread={side} current={side.id === currentId} /></li>
        {/each}
      </ul>
    </li>
  {/if}
</ul>
