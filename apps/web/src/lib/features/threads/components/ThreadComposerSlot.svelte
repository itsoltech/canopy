<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { stepSwap } from "#lib/shared/ui/motion.ts";
  import ArchivedThreadState from "./ArchivedThreadState.svelte";

  let { thread, parent, children, class: className }: { thread: ui.Thread; parent?: ui.Thread | undefined; children: Snippet; class?: ClassValue } = $props();
</script>

<div data-thread-composer-slot class={["grid min-h-44 grid-cols-1 items-end", className]}>
  {#if thread.status === "archived"}
    <div class="col-start-1 row-start-1" in:stepSwap={{ step: -1 }} out:stepSwap={{ step: 1 }}><ArchivedThreadState {thread} {parent} /></div>
  {:else}
    <div class="col-start-1 row-start-1" in:stepSwap={{ step: 1 }} out:stepSwap={{ step: -1 }}>{@render children()}</div>
  {/if}
</div>
