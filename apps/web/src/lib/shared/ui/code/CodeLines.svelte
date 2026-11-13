<script lang="ts">
  import CodeTokens from "./CodeTokens.svelte";
  import { Highlight } from "./highlight.svelte.ts";
  import type { LanguageId } from "./languages.ts";
  import type { FilePosition } from "@canopy/domain/file-references";

  /**
   * The text of a code block, one element per line, syntax-highlighted when `lang` is known (`Highlight`:
   * a line shows plain until its colours are ready, in the same place and width). While `streaming`, a
   * newly revealed line resolves in on its own (motion.css `t-stream-line`).
   */
  let {
    text,
    lang,
    streaming = false,
    position,
  }: {
    text: string;
    lang?: LanguageId | undefined;
    streaming?: boolean;
    position?: FilePosition | undefined;
  } = $props();

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
{#if !lang && !streaming && !position}{text}{:else}{#each rows as row, index (index)}{index > 0 ? "\n" : ""}<span
      data-file-line={position ? index + 1 : undefined}
      class={[
        position && "inline-block min-h-[1lh] min-w-px",
        streaming && "t-stream-line",
        position &&
          index + 1 >= position.line &&
          index + 1 <= position.end &&
          "bg-amber-400/20 outline outline-amber-500/25",
      ]}
      >{#if typeof row === "string"}{row}{:else}<CodeTokens tokens={row.tokens} />{/if}</span
    >{/each}{/if}
