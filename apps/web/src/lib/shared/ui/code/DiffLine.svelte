<script lang="ts">
  import type { DiffLine } from "./diff.ts";
  import type { Highlight } from "./highlight.svelte.ts";
  import CodeTokens from "./CodeTokens.svelte";
  import DiffGutter from "./DiffGutter.svelte";
  import type { DiffReview } from "./diff-review.ts";
  import type { DiffSide } from "@canopy/domain/diff-anchors";

  let {
    line,
    old,
    next,
    streaming = false,
    review,
    side,
  }: {
    line?: DiffLine;
    old: Highlight;
    next: Highlight;
    streaming?: boolean;
    review?: DiffReview | undefined;
    side?: DiffSide | undefined;
  } = $props();

  const found = $derived(line && line.at >= 0 ? (line.kind === "del" ? old : next).lines[line.at] : undefined);
  const highlighted = $derived(line && found?.text === line.code ? found : undefined);
</script>

<div
  class={["diff-cell diff-line", review ? "flex items-stretch" : "px-3", streaming && "t-stream-line"]}
  data-kind={line?.kind}
>
  {#if review && line?.anchor && (line.anchor.left || line.anchor.right)}<DiffGutter
      anchor={line.anchor}
      {side}
      {review}
    />{/if}
  <div class={["diff-code", review && "min-w-0 flex-1 px-3"]}>
    {#if line}
      {#if highlighted}<span class="diff-sign">{line.text.slice(0, line.text.length - line.code.length)}</span
        ><CodeTokens tokens={highlighted.tokens} />{:else}{line.text || " "}{/if}
    {:else}{" "}{/if}
  </div>
</div>
