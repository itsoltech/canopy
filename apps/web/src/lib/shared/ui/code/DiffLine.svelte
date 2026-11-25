<script lang="ts">
  import type { DiffLine } from "./diff.ts";
  import type { Highlight } from "./highlight.svelte.ts";
  import CodeTokens from "./CodeTokens.svelte";
  import DiffGutter from "./DiffGutter.svelte";
  import type { DiffReview } from "./diff-review.ts";
  import type { DiffSide } from "@canopy/domain/diff-anchors";
  import type { WordChange } from "@canopy/domain/text-diff";

  let {
    line,
    old,
    next,
    streaming = false,
    review,
    side,
    prose = false,
    words,
  }: {
    line?: DiffLine;
    old: Highlight;
    next: Highlight;
    streaming?: boolean;
    review?: DiffReview | undefined;
    side?: DiffSide | undefined;
    prose?: boolean;
    words?: readonly WordChange[] | undefined;
  } = $props();

  const found = $derived(line && line.at >= 0 ? (line.kind === "del" ? old : next).lines[line.at] : undefined);
  const highlighted = $derived(line && found?.text === line.code ? found : undefined);
</script>

<div
  class={[
    "diff-cell diff-line",
    review ? "flex items-stretch" : "px-3",
    streaming && "t-stream-line",
    prose && (line && line.at >= 0 ? "py-0.5" : "bg-zinc-950/4 py-1 font-mono text-xs/5 text-muted dark:bg-white/5"),
  ]}
  data-kind={line?.kind}
>
  {#if review && line?.anchor && (line.anchor.left || line.anchor.right)}<DiffGutter
      anchor={line.anchor}
      {side}
      {review}
    />{/if}
  <div class={[prose ? "flex gap-2 wrap-anywhere" : "diff-code", review && "min-w-0 flex-1 px-3"]}>
    {#if line}
      {#if prose && line.at >= 0}
        <span class="w-3 shrink-0 font-mono font-semibold whitespace-pre select-none" aria-hidden="true"
          >{line.text.slice(0, line.text.length - line.code.length)}</span
        >
        {#if line.kind !== "ctx"}
          <span class="sr-only select-none">{line.kind === "add" ? "Added line" : "Removed line"}</span>
        {/if}
        <span class="min-w-0 whitespace-pre-wrap">
          {#if words}
            {#each words as word, index (index)}
              {#if word.added || word.removed}
                <mark class="rounded-sm bg-zinc-950/10 text-inherit dark:bg-white/15">{word.value}</mark>
              {:else}
                {word.value}
              {/if}
            {/each}
          {:else}
            {line.code}
          {/if}
        </span>
      {:else if highlighted}<span class="diff-sign">{line.text.slice(0, line.text.length - line.code.length)}</span
        ><CodeTokens tokens={highlighted.tokens} />{:else}{line.text || " "}{/if}
    {:else}{" "}{/if}
  </div>
</div>
