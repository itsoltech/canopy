<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import LineageRow from "./LineageRow.svelte";

  let {
    threads,
    currentId,
    label,
    finished = false,
    class: className,
  }: {
    threads: readonly ui.Thread[];
    currentId: string;
    label: string;
    finished?: boolean;
    class?: ClassValue;
  } = $props();
</script>

{#if threads.length}
  <ul role="list" aria-label={label} class={["grid min-w-0 grid-cols-1 gap-0.5", className]}>
    {#each threads as thread (thread.id)}
      <li><LineageRow {thread} {currentId} {finished} /></li>
    {/each}
  </ul>
{/if}
