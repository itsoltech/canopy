/** The first line of a markdown message as plain text, and whether more follows it (another line, a block). */
export interface FirstLine {
  readonly text: string;
  readonly more: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BLOCK_MARK = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

/** Inline markdown to the text it shows: links and images to their label, emphasis and code marks dropped. */
const plain = (line: string): string =>
  line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The line a folded message shows: the first line with text, without its block marks (heading, quote, list
 * item); a code block's first line when the message opens with one. `more`: anything else in the message.
 */
export function firstLine(text: string): FirstLine {
  const lines = text.split("\n").filter((line) => line.trim() && !RULE.test(line));
  const line = lines.find((candidate) => !FENCE.test(candidate)) ?? "";

  return { text: plain(line.replace(BLOCK_MARK, "")), more: lines.length > 1 || BLOCK_MARK.test(line) };
}
