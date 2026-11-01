<script lang="ts">
  import { Lexer } from "marked";
  import type { ClassValue } from "svelte/elements";
  import MarkdownBlocks from "./MarkdownBlocks.svelte";

  /**
   * Markdown from agents, rendered from marked's token tree by Svelte components. Nothing is
   * injected as HTML: raw HTML in the source shows as text, links are limited to http(s)/mailto and
   * images are not loaded (they render as links).
   */
  let { text, class: className }: { text: string; class?: ClassValue } = $props();
  const tokens = $derived(Lexer.lex(text, { gfm: true, breaks: false }));
</script>

<div class={["grid gap-3 text-base/7 text-pretty break-words text-zinc-800 sm:text-sm/6 dark:text-zinc-200", className]}>
  <MarkdownBlocks {tokens} />
</div>
