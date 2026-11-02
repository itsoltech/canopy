<script lang="ts">
  import MarkdownInline from "./MarkdownInline.svelte";
  import { snippetTokens } from "./tokens.ts";

  /**
   * A message's markdown as one line of inline formatting (bold, italics, code, link text) for previews; the
   * caller truncates or clamps the element it sits in. Nothing here is a link: previews are inside links.
   */
  let { text }: { text: string } = $props();
  const tokens = $derived(snippetTokens(text));
</script>

<!-- Bold stays bold but a step under the full text colour: a preview is muted as a whole. -->
<span class="[&_strong]:text-zinc-700 dark:[&_strong]:text-zinc-200"><MarkdownInline {tokens} /></span>
