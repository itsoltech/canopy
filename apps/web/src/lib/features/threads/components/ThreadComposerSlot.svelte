<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { resizeHeightToContent } from "#lib/shared/ui/motion.ts";
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

<!-- A single measured height animates the overlay. Its natural-size child stays bottom-aligned;
     internal folds switch immediately and never send intermediate sizes back to the timeline. -->
<div class={["t-resize-height relative min-w-0", className]} {@attach resizeHeightToContent}>
  <div
    data-thread-composer-slot
    data-compact={compact || undefined}
    class="t-composer-slot absolute inset-x-0 bottom-0 grid grid-cols-1 items-end"
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
</div>
