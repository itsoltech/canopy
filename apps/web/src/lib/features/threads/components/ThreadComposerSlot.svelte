<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import ArchivedThreadState from "./ArchivedThreadState.svelte";
  import ImportedThreadState from "./ImportedThreadState.svelte";

  let {
    thread,
    parent,
    children,
    compact = false,
    class: className,
  }: {
    thread: ui.Thread;
    parent?: ui.Thread | undefined;
    children: Snippet;
    compact?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<!-- VirtualFeed owns the single outer shell; this natural-size slot supplies its target geometry. -->
<div
  data-thread-composer-slot
  data-compact={compact || undefined}
  class={["t-composer-slot grid min-w-0 grid-cols-1 items-end", className]}
>
  {#if thread.status === "archived"}
    <div class="col-start-1 row-start-1">
      <ArchivedThreadState {thread} {parent} />
    </div>
  {:else if thread.import?.mode === "history"}
    <div class="col-start-1 row-start-1">
      <ImportedThreadState {thread} />
    </div>
  {:else}
    <div class="col-start-1 row-start-1">
      {@render children()}
    </div>
  {/if}
</div>
