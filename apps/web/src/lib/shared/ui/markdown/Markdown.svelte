<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { LineReveal } from "../streaming/line-reveal.svelte.ts";
  import MarkdownBlocks from "./MarkdownBlocks.svelte";
  import { provideInlineElements, withSentinels, type InlineElements } from "./inline-elements.ts";
  import { StreamingTokens } from "./streaming-tokens.ts";
  import { provideImages, type ImageRenderer } from "./images.ts";
  import { provideDiagrams } from "./diagrams.ts";

  /**
   * Markdown from agents, rendered from marked's token tree by Svelte components. Nothing is
   * injected as HTML: allowlisted source elements become inert trees rendered by Svelte. Links and
   * images use the caller’s existing file handlers and image policy; scripts and source styles are dropped.
   *
   * `breaks`: preserve prose whitespace, including single line breaks, spaces and tabs (people and bus messages).
   *
   * `streaming`: the text is still arriving. It shows line by line (`LineReveal`), is parsed again only
   * when a line is revealed, re-lexing the last block when earlier blocks are independent
   * (`StreamingTokens`); unchanged tokens retain their identity. Each new block,
   * list item, table row and code line resolves in (motion.css `t-stream`).
   *
   * `elements`: the caller's inline elements over ranges of `text` (mention chips; inline-elements.ts).
   *
   * `diagrams`: draw ` ```mermaid ` fences as diagrams (`MermaidDiagram`) once the text is complete.
   */
  let {
    text,
    streaming = false,
    breaks = false,
    elements,
    image,
    diagrams = false,
    class: className,
  }: {
    text: string;
    streaming?: boolean;
    breaks?: boolean;
    elements?: InlineElements | undefined;
    image?: ImageRenderer;
    diagrams?: boolean;
    class?: ClassValue;
  } = $props();

  provideImages({
    get render() {
      return image;
    },
  });

  provideDiagrams({
    get enabled() {
      return diagrams && !streaming;
    },
  });

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

  const parser = new StreamingTokens();
  const tokens = $derived(parser.update(reveal.text, breaks));
</script>

<div
  class={[
    "grid grid-cols-1 gap-3 text-base/7 text-pretty wrap-anywhere text-zinc-800 select-text sm:text-sm/6 dark:text-zinc-200",
    streaming && "t-stream",
    className,
  ]}
>
  <MarkdownBlocks {tokens} {streaming} {breaks} />
</div>
