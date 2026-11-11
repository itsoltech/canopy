<script lang="ts">
  import { selectedLine, type DiffSide } from "@canopy/domain/diff-anchors";
  import type { DiffAnchor } from "@canopy/domain/diff-anchors";
  import type { DiffReview } from "./diff-review.ts";

  let { anchor, side, review }: { anchor: DiffAnchor; side?: DiffSide | undefined; review: DiffReview } = $props();
  const sides = $derived<DiffSide[]>(side ? [side] : ["LEFT", "RIGHT"]);
</script>

<div
  class="sticky left-0 z-1 flex shrink-0 self-stretch bg-surface font-mono text-xs/5 text-zinc-500 select-none dark:text-zinc-400"
>
  {#each sides as s (s)}
    {@const value = s === "LEFT" ? anchor.left : anchor.right}
    {#if value}
      <button
        type="button"
        class={[
          "w-12 shrink-0 border-r border-divider px-1 text-right tabular-nums focus-ring hover:bg-zinc-500/10 pointer-coarse:min-h-12",
          selectedLine(review.selection, s, value) && "bg-sky-500/15 text-sky-700 dark:text-sky-300",
        ]}
        aria-label={`Add comment on ${s} line ${value}`}
        aria-pressed={selectedLine(review.selection, s, value)}
        onpointerdown={(event) =>
          review.onstart({ side: s, line: value }, event.shiftKey, event.pointerType === "mouse")}
        onpointerenter={() => review.onenter({ side: s, line: value })}
        onclick={(event) => {
          if (!event.detail) review.onstart({ side: s, line: value }, event.shiftKey, false);
        }}>{value}</button
      >
    {:else}<span class="w-12 shrink-0 border-r border-divider" aria-hidden="true"></span>{/if}
  {/each}
</div>
