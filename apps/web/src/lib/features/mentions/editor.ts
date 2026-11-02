import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention } from "@open-agents/contracts";
import { mentionLabel, mentionPlaceholder } from "@open-agents/domain";
import { INLINE_RENDERERS, type InlineElement, type MentionData } from "./kinds.ts";
import { blockHtml, fenceText, findFences, inlineHtml, type CodeBlockData } from "./markdown.ts";

/**
 * The composer's text model and its DOM (MentionEditor.svelte, a contenteditable). The model is the message text
 * plus inline elements with their ranges (Mention: [start, end) in UTF-16 units over the placeholder text); the
 * DOM holds text nodes, `<br>` for line breaks, one non-editable chip per inline element, `<code>` around inline code
 * spans (the backticks stay text) and one non-editable block per fenced code block (markdown.ts). Every edit goes through
 * the browser (typing, IME, `insertText` / `insertHTML`), so undo, spellcheck and mobile keyboards work natively;
 * the model is read back from the DOM after each input.
 */

/** The DOM bits serialization needs (Node, so tests can pass plain objects). */
export interface EditorNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<EditorNode>;
  readonly dataset?: DOMStringMap;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCKS = new Set(["DIV", "P", "LI"]);

export interface EditorValue {
  readonly text: string;
  readonly mentions: Mention[];
}

/** The inline element a chip stands for, from its data attributes. */
export function elementOf(node: EditorNode): InlineElement | undefined {
  if (node.dataset?.["element"] !== "mention") return undefined;
  try {
    const data = JSON.parse(node.dataset["mention"] ?? "") as MentionData;
    return { type: "mention", mention: data };
  } catch {
    return undefined;
  }
}

/** The fenced code block an editor block element stands for, from its data attributes. */
export function blockOf(node: EditorNode): CodeBlockData | undefined {
  if (node.dataset?.["block"] !== "code") return undefined;
  return { lang: node.dataset["lang"] ?? "", code: node.dataset["code"] ?? "", fence: Number(node.dataset["fence"]) || 3 };
}

/**
 * The editor's text and mentions. A `<br>` is a line break, except the browser's last `<br>` that only keeps an empty
 * last line visible; a block (pasted or typed by a browser that wraps lines in `<div>`) starts a new line. A code
 * block is its fence's lines.
 */
export function serialize(root: EditorNode): EditorValue {
  let text = "";
  const mentions: Mention[] = [];
  // A block ends its line: the next content starts on a new one.
  let pendingBreak = false;
  const flush = () => {
    if (pendingBreak) text += "\n";
    pendingBreak = false;
  };
  const walk = (node: EditorNode) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i]!;
      if (child.nodeType === TEXT_NODE) {
        const data = (child.textContent ?? "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
        if (!data) continue;
        flush();
        text += data;
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const block = blockOf(child);
      if (block) {
        if (!pendingBreak && text && !text.endsWith("\n")) text += "\n";
        flush();
        text += fenceText(block);
        pendingBreak = true;
        continue;
      }
      const element = elementOf(child);
      if (element) {
        flush();
        const placeholder = mentionPlaceholder(element.mention);
        mentions.push(create(MentionSchema, { ...withoutIcon(element.mention), start: text.length, end: text.length + placeholder.length }));
        text += placeholder;
        continue;
      }
      if (child.nodeName === "BR") {
        flush();
        text += "\n";
        continue;
      }
      if (BLOCKS.has(child.nodeName)) {
        // A block starts its own line ("a<div>b</div>").
        if (!pendingBreak && text && !text.endsWith("\n")) text += "\n";
        flush();
        // <div><br></div> is an empty line: the <br> only keeps it visible.
        if (!(child.childNodes.length === 1 && child.childNodes[0]!.nodeName === "BR")) walk(child);
        pendingBreak = true;
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  const last = root.childNodes[root.childNodes.length - 1];
  if (last?.nodeName === "BR" && text.endsWith("\n")) text = text.slice(0, -1);
  return { text, mentions };
}

function withoutIcon(m: MentionData): Omit<MentionData, "icon"> {
  const { icon: _icon, ...rest } = m;
  return rest;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * HTML for a model (setting the editor's content from outside: a cleared or restored draft, a paste with fences).
 * Complete fences without mentions in them become blocks; the text around them renders by lines, with its inline
 * code. A block is its own lines, so the line break before and after it is the block's edge: a run of text that ends
 * with an empty line before a block, or after the last one, needs one more `<br>` to show it (as at the end).
 */
export function toHtml(value: EditorValue, icons: ReadonlyMap<string, string> = new Map(), renderMention?: (mention: MentionData) => string): string {
  const fences = findFences(value.text).filter((f) => !value.mentions.some((m) => m.start < f.end && m.end > f.start));
  if (fences.length === 0) return value.text ? runHtml(value, 0, value.text.length, icons, renderMention) : "";
  let html = "";
  let at = 0;
  for (const fence of fences) {
    // The text before the fence, without the line break that ends it.
    if (fence.start > at) html += runHtml(value, at, fence.start - 1, icons, renderMention);
    html += blockHtml(fence);
    at = fence.end + 1;
  }
  if (at <= value.text.length) html += runHtml(value, at, value.text.length, icons, renderMention);
  return html;
}

/** Text `[from, to)` with its mentions as chips and its inline code; an empty last line gets its extra `<br>`. */
function runHtml(value: EditorValue, from: number, to: number, icons: ReadonlyMap<string, string>, renderMention?: (mention: MentionData) => string): string {
  let html = "";
  let at = from;
  for (const m of [...value.mentions].sort((a, b) => a.start - b.start)) {
    if (m.start < at || m.end > to) continue;
    html += inlineHtml(value.text.slice(at, m.start));
    const icon = icons.get(iconKey(m));
    const mention = { ...m, ...(icon && { icon }) };
    html += renderMention ? renderMention(mention) : INLINE_RENDERERS.mention.html({ type: "mention", mention });
    at = m.end;
  }
  html += inlineHtml(value.text.slice(at, to));
  const run = value.text.slice(from, to);
  if (run === "" || run.endsWith("\n")) html += "<br>";
  return html;
}

export const iconKey = (m: Pick<Mention, "kind" | "name">) => `${m.kind}:${m.name}`;

export type TriggerChar = "/" | "$" | "@" | "#";

export interface ActiveTrigger {
  readonly char: TriggerChar;
  /** What was typed after the trigger. */
  readonly query: string;
  /** Characters from the trigger to the caret (to select and replace them with the chip). */
  readonly length: number;
}

/**
 * The trigger the caret is in: a trigger character at the start of the line or after whitespace, then the query up
 * to the caret without whitespace ("#" allows single spaces, thread titles have them).
 */
export function activeTrigger(before: string, enabled: ReadonlySet<TriggerChar>): ActiveTrigger | undefined {
  const match = /(?:^|[\s ])([/$@#])([^\s ]*)$/.exec(before) ?? /(?:^|[\s ])(#)((?:[^\s #]+ ?){0,6})$/.exec(before);
  if (!match) return undefined;
  const char = match[1] as TriggerChar;
  const query = match[2] ?? "";
  if (!enabled.has(char) || query.length > 120) return undefined;
  return { char, query, length: query.length + 1 };
}

export const MENTION_KIND_OF: Record<Exclude<TriggerChar, "$">, MentionKind> = { "/": MentionKind.COMMAND, "@": MentionKind.FILE, "#": MentionKind.THREAD };

/** The value without surrounding whitespace, ranges moved along (mentions are never whitespace). */
export function trimValue(value: EditorValue): EditorValue {
  const lead = value.text.length - value.text.trimStart().length;
  const text = value.text.trim();
  return {
    text,
    mentions: value.mentions.filter((m) => m.end - lead <= text.length).map((m) => create(MentionSchema, { ...m, start: m.start - lead, end: m.end - lead })),
  };
}

/**
 * A transcript user message without the platform's note in front (the gateway puts "[open-agents] …" lines, an
 * empty line, then the message), its mentions moved along; unchanged when it has no such note.
 */
export function withoutPlatformNote(value: EditorValue): EditorValue {
  if (!value.text.startsWith("[open-agents]")) return value;
  const cut = value.text.indexOf("\n\n");
  if (cut < 0) return value;
  const shift = cut + 2;
  return {
    text: value.text.slice(shift),
    mentions: value.mentions.filter((m) => m.start >= shift).map((m) => create(MentionSchema, { ...m, start: m.start - shift, end: m.end - shift })),
  };
}

/** The text as people read it: each mention as its chip's label (a thread title from the first message). */
export function readableText(value: EditorValue): string {
  let out = "";
  let at = 0;
  for (const m of [...value.mentions].sort((a, b) => a.start - b.start)) {
    if (m.start < at || m.end > value.text.length) continue;
    out += value.text.slice(at, m.start) + mentionLabel(m);
    at = m.end;
  }
  return out + value.text.slice(at);
}
