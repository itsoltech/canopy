<script lang="ts">
  import CodeTokens from "./CodeTokens.svelte";
  import { Highlight } from "./highlight.svelte.ts";
  import type { LanguageId } from "./languages.ts";

  /**
   * The text of a code block, one element per line, syntax-highlighted when `lang` is known (`Highlight`:
   * a line shows plain until its colours are ready, in the same place and width). While `streaming`, a
   * newly revealed line resolves in on its own (motion.css `t-stream-line`).
   */
  let { text, lang, streaming = false }: { text: string; lang?: LanguageId | undefined; streaming?: boolean } = $props();

  const highlight = new Highlight(
    () => text,
    () => lang,
  );
  // A line keeps its highlighted object while its text is unchanged, so its DOM is left alone.
  const rows = $derived(
    text.split("\n").map((line, index) => {
      const highlighted = highlight.lines[index];
      return highlighted?.text === line ? highlighted : line;
    }),
  );
</script>

<!-- One line: this renders inside a <pre>, where whitespace in the template would show. -->
{#if !lang && !streaming}{text}{:else}{#each rows as row, index (index)}<span class={streaming ? "t-stream-line" : undefined}>{index > 0 ? "\n" : ""}{#if typeof row === "string"}{row}{:else}<CodeTokens tokens={row.tokens} />{/if}</span>{/each}{/if}
