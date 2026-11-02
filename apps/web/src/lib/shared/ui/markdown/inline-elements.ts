import { getContext, setContext, type Snippet } from "svelte";

/**
 * Elements a caller renders inside markdown text (e.g. mention chips in a sent message): each range of the source is
 * swapped for a private-use sentinel before lexing (no markdown syntax can split it), and `MarkdownInline` renders
 * the caller's snippet where a sentinel appears. In code (spans and blocks) the original text comes back.
 */
export interface InlineElements {
  /** Ranges of the source, UTF-16, not overlapping. */
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  /** Renders the element at that index of `ranges`. */
  readonly render: Snippet<[number]>;
}

const OPEN = "";
const CLOSE = "";
const SENTINEL = /(\d+)/g;
const KEY = Symbol("markdown-inline-elements");

interface Context {
  readonly render: Snippet<[number]>;
  /** Code text with each sentinel back to the source it replaced. */
  restore(text: string): string;
}

/** The source with sentinels, and the context MarkdownInline and code blocks read. */
export function withSentinels(text: string, elements: InlineElements): { text: string; context: Context } {
  const originals: string[] = [];
  let out = "";
  let at = 0;
  [...elements.ranges]
    .map((range, index) => ({ ...range, index }))
    .sort((a, b) => a.start - b.start)
    .forEach(({ start, end, index }) => {
      if (start < at || end > text.length || end <= start) return;
      out += text.slice(at, start) + `${OPEN}${index}${CLOSE}`;
      originals[index] = text.slice(start, end);
      at = end;
    });
  out += text.slice(at);
  return {
    text: out,
    context: { render: elements.render, restore: (code) => code.replace(SENTINEL, (_, i: string) => originals[Number(i)] ?? "") },
  };
}

export const provideInlineElements = (context: Context | undefined) => setContext(KEY, context);
export const useInlineElements = () => getContext<Context | undefined>(KEY);

/** Text split at sentinels: strings and element indexes. */
export function splitSentinels(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let at = 0;
  for (const match of text.matchAll(SENTINEL)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(Number(match[1]));
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
