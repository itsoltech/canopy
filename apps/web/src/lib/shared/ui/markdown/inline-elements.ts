import { getContext, setContext, type Snippet } from "svelte";
import { withSentinels as sentinels, type SentinelRange } from "@canopy/domain/markdown";

/**
 * Elements a caller renders inside markdown text (e.g. mention chips in a sent message): each range of the source is
 * swapped for a private-use sentinel before lexing (`@canopy/domain/markdown`), and `MarkdownInline` renders the
 * caller's snippet where a sentinel appears. In code (spans and blocks) the original text comes back.
 */
export interface InlineElements {
  /** Ranges of the source, UTF-16, not overlapping. */
  readonly ranges: readonly SentinelRange[];
  /** Renders the element at that index of `ranges`. */
  readonly render: Snippet<[number]>;
}

const KEY = Symbol("markdown-inline-elements");

interface Context {
  readonly render: Snippet<[number]>;
  /** Code text with each sentinel back to the source it replaced. */
  restore(text: string): string;
}

export interface WithSentinels {
  text: string;
  context: Context;
}

/** The source with sentinels, and the context MarkdownInline and code blocks read. */
export function withSentinels(text: string, elements: InlineElements): WithSentinels {
  const marked = sentinels(text, elements.ranges);

  return { text: marked.text, context: { render: elements.render, restore: marked.restore } };
}

export const provideInlineElements = (context: Context | undefined) => setContext(KEY, context);
export const useInlineElements = () => getContext<Context | undefined>(KEY);

export { splitSentinels } from "@canopy/domain/markdown";
