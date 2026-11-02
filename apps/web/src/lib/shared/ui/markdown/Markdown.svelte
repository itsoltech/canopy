<script lang="ts">
  import type { Token } from "marked";
  import type { ClassValue } from "svelte/elements";
  import { LineReveal } from "../streaming/line-reveal.svelte.ts";
  import MarkdownBlocks from "./MarkdownBlocks.svelte";
  import { provideInlineElements, withSentinels, type InlineElements } from "./inline-elements.ts";
  import { lexMarkdown, shareTokens } from "./tokens.ts";

  /**
   * Markdown from agents, rendered from marked's token tree by Svelte components. Nothing is
   * injected as HTML: raw HTML in the source shows as text, links are limited to http(s)/mailto and
   * images are not loaded (they render as links).
   *
   * `breaks`: single newlines break the line (what people type in the composer).
   *
   * `streaming`: the text is still arriving. It shows line by line (`LineReveal`), is parsed again only
   * when a line is revealed, and only blocks that changed render again (`shareTokens`); each new block,
   * list item, table row and code line resolves in (motion.css `t-stream`).
   *
   * `elements`: the caller's inline elements over ranges of `text` (mention chips; inline-elements.ts).
   */
  let {
    text,
    streaming = false,
    breaks = false,
    elements,
    class: className,
  }: { text: string; streaming?: boolean; breaks?: boolean; elements?: InlineElements | undefined; class?: ClassValue } = $props();
  const marked = $derived(elements && elements.ranges.length > 0 ? withSentinels(text, elements) : undefined);
  // Read through getters: the context follows the props. `render` is only reached through a sentinel, so with elements.
  provideInlineElements({
    get render() {
      return elements!.render;
    },
    restore: (code: string) => marked?.context.restore(code) ?? code,
  });
  const reveal = new LineReveal(
    () => marked?.text ?? text,
    () => streaming,
  );
  let previous: Token[] = [];
  const tokens = $derived((previous = shareTokens(previous, lexMarkdown(reveal.text, breaks))));
</script>

<div class={["grid gap-3 text-base/7 text-pretty break-words text-zinc-800 sm:text-sm/6 dark:text-zinc-200", streaming && "t-stream", className]}>
  <MarkdownBlocks {tokens} {streaming} />
</div>
