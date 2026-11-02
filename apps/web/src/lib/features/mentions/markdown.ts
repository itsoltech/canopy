/**
 * Live markdown of the composer (docs/ui-api.md, "Wzmianki" → "Markdown na żywo"): the two constructs the editor
 * formats while typing, as pure text rules shared by the DOM (MentionEditor, inline-code.ts) and the model
 * (editor.ts `serialize` / `toHtml`). The text never changes: formatting only shows what the markdown already says.
 *
 * - Inline code: a single-backtick span on one line (`` `npm i` ``). The backticks stay text, around a `<code>`
 *   with the span's content; a chip or a line break ends the run a span may live in.
 * - Fenced code block: an opening line of three or more backticks with an optional language word, the code, and a
 *   closing line of the same backticks. In the editor it is one block element whose code and language live in data
 *   attributes; it serializes back to exactly that text.
 */

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Content ranges `[start, end)` of the inline code spans in a run of text (the backticks are around them). */
export function codeSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    if (!match[1]!.trim()) continue;
    const start = match.index + 1;
    spans.push([start, start + match[1]!.length]);
  }
  return spans;
}

/** Inline code as it looks in the editor (the chat's `codespan` look, MarkdownInline.svelte). */
export const INLINE_CODE_CLASS = "rounded-sm bg-zinc-950/5 box-decoration-clone px-1 py-px font-mono text-[0.875em] text-zinc-950 dark:bg-white/10 dark:text-white";

/** HTML of one run of text with its code spans (`fresh`: just typed, it fades in). Line breaks become `<br>`. */
export function inlineHtml(text: string, fresh = false): string {
  let html = "";
  let at = 0;
  const plain = (s: string) => s.split("\n").map(escapeHtml).join("<br>");
  for (const [start, end] of codeSpans(text)) {
    html += `${plain(text.slice(at, start))}<code data-md="code" class="${INLINE_CODE_CLASS}${fresh ? " t-code-form" : ""}">${escapeHtml(text.slice(start, end))}</code>`;
    at = end;
  }
  return html + plain(text.slice(at));
}

export interface CodeBlockData {
  /** The fence's language word, as typed (`ts`, `python`, `` for none). */
  readonly lang: string;
  readonly code: string;
  /** Backticks of the fence (3, more when the code has a line of backticks of its own). */
  readonly fence: number;
}

export interface FencedBlock extends CodeBlockData {
  /** Range of the fence in the text, from the opening line to the end of the closing one. */
  readonly start: number;
  readonly end: number;
}

/** The fence markdown of a block: the code verbatim, between fences long enough that no line of it closes them. */
export function fenceText({ lang, code, fence }: CodeBlockData): string {
  let longest = 0;
  for (const match of code.matchAll(/^ {0,3}(`{3,})/gm)) longest = Math.max(longest, match[1]!.length);
  const ticks = "`".repeat(Math.max(3, fence, longest + 1));
  return code ? `${ticks}${lang}\n${code}\n${ticks}` : `${ticks}${lang}\n${ticks}`;
}

const OPENING = /^(`{3,})([^`\s]*)$/;

/**
 * Complete fences in a text: an opening line (backticks, optional language word, nothing else), then lines up to a
 * line of the same backticks. Only fences a block writes back the same way count (`fenceText`), so a text always
 * round-trips; anything else (unclosed, `~~~`, an info string with spaces) stays plain text.
 */
export function findFences(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const open = OPENING.exec(lines[i]!);
    if (!open) continue;
    const ticks = open[1]!;
    let close = i + 1;
    while (close < lines.length && lines[close] !== ticks) close++;
    if (close >= lines.length) continue;
    const block = { lang: open[2]!, code: lines.slice(i + 1, close).join("\n"), fence: ticks.length };
    const start = starts[i]!;
    const end = starts[close]! + ticks.length;
    if (fenceText(block) !== text.slice(start, end)) continue;
    blocks.push({ ...block, start, end });
    i = close;
  }
  return blocks;
}

/** The fence an opening line asks for (`` ``` ``, `` ```ts ``), when the line is nothing else. */
export function openingFence(line: string): { lang: string; fence: number } | undefined {
  const open = OPENING.exec(line);
  return open ? { lang: open[2]!, fence: open[1]!.length } : undefined;
}

/**
 * The block in the editor's DOM: a non-editable element holding the code and the language in data attributes
 * (serialization reads them; CodeBlockField mounts into it and keeps them current). Its content before the field
 * mounts is the code in a `<pre>` (an empty element could be dropped by the browser's `insertHTML`).
 */
export function blockHtml(block: CodeBlockData, fresh = false): string {
  return `<div contenteditable="false" data-block="code" data-lang="${escapeHtml(block.lang)}" data-code="${escapeHtml(block.code)}" data-fence="${block.fence}"${fresh ? ' data-fresh=""' : ""} class="my-1 first:mt-0 last:mb-0"><pre class="code-surface p-3">${escapeHtml(block.code) || " "}</pre></div>`;
}
