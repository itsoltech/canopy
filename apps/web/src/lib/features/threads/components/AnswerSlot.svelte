<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { expand } from "#lib/shared/ui/motion.ts";
  import type { TimelineRow } from "../timeline.ts";
  import TimelineRowView from "./TimelineRowView.svelte";

  /** Stable virtual row: a progress message shrinks into the fold when tools resume. */
  let { row, class: className }: { row: TimelineRow | undefined; class?: ClassValue } = $props();
</script>

<div class={className}>
  {#if row}
    <div transition:expand={{ instantReduced: true }}>
      <div class="pb-3" data-answer-item={row.kind === "item" ? row.node.entry.id : undefined}>
        {#key row.key}<TimelineRowView {row} />{/key}
      </div>
    </div>
  {/if}
</div>
