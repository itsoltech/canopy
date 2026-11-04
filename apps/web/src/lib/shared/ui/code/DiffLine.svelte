<script lang="ts">
  import type { DiffLine } from "./diff.ts";
  import type { Highlight } from "./highlight.svelte.ts";
  import CodeTokens from "./CodeTokens.svelte";

  let {
    line,
    old,
    next,
    streaming = false,
  }: { line?: DiffLine; old: Highlight; next: Highlight; streaming?: boolean } = $props();

  const found = $derived(line && line.at >= 0 ? (line.kind === "del" ? old : next).lines[line.at] : undefined);
  const highlighted = $derived(line && found?.text === line.code ? found : undefined);
</script>

<div class={["diff-cell diff-line px-3", streaming && "t-stream-line"]} data-kind={line?.kind}>
  {#if line}
    {#if highlighted}<span class="diff-sign">{line.text.slice(0, line.text.length - line.code.length)}</span><CodeTokens
        tokens={highlighted.tokens}
      />{:else}{line.text || " "}{/if}
  {:else}{" "}{/if}
</div>
