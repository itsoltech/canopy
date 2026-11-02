import { blockOf, elementOf } from "./editor.ts";
import { inlineSpans, inlineHtml } from "./markdown.ts";

/**
 * Live inline code in the editor's DOM (markdown.ts has the rules). After an edit, each run of text (between chips,
 * line breaks of `<br>` and blocks) is compared with what its text says; a line that differs (a closing backtick was
 * typed, a backtick deleted, the browser left styled `<font>` / `<span>` behind) is written again with
 * `insertHTML`, so the change is one step of the browser's undo stack: Undo first takes the formatting back, the
 * backticks stay. Undo and redo themselves are never reformatted (the editor skips this for `history*` input).
 */

const markdownMask = (node: Node): number | undefined => {
  if (!(node instanceof HTMLElement)) return undefined;
  if (node.nodeName === "CODE" && node.dataset["md"] === "code") return 1;
  if (node.nodeName === "STRONG" && node.dataset["md"] === "strong") return 2;
  if (node.nodeName === "EM" && node.dataset["md"] === "em") return 4;
  return undefined;
};
/** Elements a run never crosses: chips, blocks, line breaks and line blocks. */
const isBoundary = (node: Node) =>
  node instanceof HTMLElement && (node.nodeName === "BR" || node.nodeName === "DIV" || node.nodeName === "P" || node.nodeName === "LI" || elementOf(node) !== undefined || blockOf(node) !== undefined);

interface Run {
  readonly nodes: Node[];
  readonly text: string;
}

function runsOf(container: Node, out: Run[] = []): Run[] {
  let nodes: Node[] = [];
  const end = () => {
    if (nodes.length) out.push({ nodes, text: nodes.map((n) => n.textContent ?? "").join("") });
    nodes = [];
  };
  for (const child of container.childNodes) {
    if (child.nodeType === Node.TEXT_NODE || (child.nodeType === Node.ELEMENT_NODE && !isBoundary(child))) {
      nodes.push(child);
      continue;
    }
    end();
    // A line block (a browser's <div> line) holds runs of its own; chips and code blocks hold none.
    if (child instanceof HTMLElement && !elementOf(child) && !blockOf(child) && child.nodeName !== "BR") runsOf(child, out);
  }
  end();
  return out;
}

/** Per character: code/emphasis bits, plain (0), or foreign markup (128). */
function actualMask(run: Run): Uint8Array {
  const mask = new Uint8Array(run.text.length);
  let at = 0;
  const walk = (node: Node, inherited: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      mask.fill(inherited, at, at + length);
      at += length;
    } else {
      const style = markdownMask(node);
      for (const child of node.childNodes) walk(child, inherited | (style ?? 128));
    }
  };
  for (const node of run.nodes) walk(node, 0);
  return mask;
}

function desiredMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const { start, end, mask: style } of inlineSpans(text)) for (let i = start; i < end; i++) mask[i] = mask[i]! | style;
  return mask;
}

/** DOM position of a character offset in a run (text nodes only; offsets at a node's edge stay in plain text). */
function positionIn(run: Run, offset: number): { node: Node; offset: number } | undefined {
  let at = 0;
  for (const node of run.nodes) {
    const length = node.textContent?.length ?? 0;
    if (offset < at + length || (offset === at + length && node.nodeType === Node.TEXT_NODE)) {
      if (node.nodeType === Node.TEXT_NODE) return { node, offset: offset - at };
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let relative = offset - at;
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const size = text.textContent?.length ?? 0;
        if (relative <= size) return { node: text, offset: relative };
        relative -= size;
      }
      return undefined;
    }
    at += length;
  }
  return undefined;
}

/** The caret's offset in a run, when it is in it. */
function caretIn(run: Run): number | undefined {
  const selection = getSelection();
  if (!selection?.isCollapsed || selection.rangeCount === 0) return undefined;
  const { anchorNode, anchorOffset } = selection;
  let at = 0;
  for (const node of run.nodes) {
    if (node === anchorNode || node.contains(anchorNode)) {
      if (anchorNode?.nodeType === Node.TEXT_NODE) {
        let before = 0;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let t = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode(); t && t !== anchorNode; t = walker.nextNode()) before += t.textContent?.length ?? 0;
        return at + before + anchorOffset;
      }
      return at + (anchorOffset > 0 ? (node.textContent?.length ?? 0) : 0);
    }
    at += node.textContent?.length ?? 0;
  }
  return undefined;
}

/** Writes lines `[from, to)` of a run again, as `inlineHtml` renders them; true when the browser took it. */
function rewrite(run: Run, from: number, to: number, fresh: boolean): boolean {
  const range = document.createRange();
  // Edges are whole nodes at the run's ends and points right after / before a line break inside: never the edge of a
  // <code>, where the browser would carry the code's style into the new text.
  if (from === 0) range.setStartBefore(run.nodes[0]!);
  else {
    const start = positionIn(run, from);
    if (!start) return false;
    range.setStart(start.node, start.offset);
  }
  if (to === run.text.length) range.setEndAfter(run.nodes[run.nodes.length - 1]!);
  else {
    const end = positionIn(run, to);
    if (!end) return false;
    range.setEnd(end.node, end.offset);
  }
  const caret = caretIn(run);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const done = document.execCommand("insertHTML", false, inlineHtml(run.text.slice(from, to), fresh) || "");
  // The caret ends after what was inserted: walk back to where it was.
  if (done && caret !== undefined && caret >= from && caret <= to) moveBack(to - caret);
  return done;
}

function moveBack(characters: number) {
  const selection = getSelection();
  if (!selection || characters <= 0) return;
  for (let i = 0; i < characters; i++) selection.modify("move", "backward", "character");
}

/** Brings the inline code of `root` in line with its text; true when something was written again. */
export function formatInlineCode(root: HTMLElement): boolean {
  let changed = false;
  for (const run of runsOf(root)) {
    const actual = actualMask(run);
    const desired = desiredMask(run.text);
    let first = -1;
    let last = -1;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] === desired[i]) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) continue;
    // Whole lines of the run, so neither edge falls inside a span or a <code>; markup that has to go, the whole run.
    const foreign = actual.some((v) => (v & 128) !== 0);
    const from = foreign ? 0 : run.text.lastIndexOf("\n", first) + 1;
    const lineEnd = run.text.indexOf("\n", last);
    const to = foreign || lineEnd < 0 ? run.text.length : lineEnd;
    // A span that appeared (not one that went or got longer) fades in.
    const fresh = desired.slice(from, to).some((v, i) => v === 1 && actual[from + i] === 0) && !actual.slice(from, to).includes(1);
    changed = rewrite(run, from, to, fresh) || changed;
  }
  return changed;
}

/**
 * The backticks around each inline code, muted (CSS Custom Highlight API: no markup, so typing and the caret are
 * untouched; without the API they keep the text colour). One highlight for every editor on the page.
 */
const TICKS = "composer-code-tick";
const ticksOf = new WeakMap<HTMLElement, Range[]>();

export function markTicks(root: HTMLElement): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  let highlight = CSS.highlights.get(TICKS);
  if (!highlight) {
    highlight = new Highlight();
    CSS.highlights.set(TICKS, highlight);
  }
  for (const range of ticksOf.get(root) ?? []) highlight.delete(range);
  const ranges: Range[] = [];
  for (const code of root.querySelectorAll<HTMLElement>('code[data-md="code"]')) {
    const before = code.previousSibling;
    const after = code.nextSibling;
    if (before?.nodeType === Node.TEXT_NODE && before.textContent?.endsWith("`")) {
      const range = document.createRange();
      range.setStart(before, before.textContent.length - 1);
      range.setEnd(before, before.textContent.length);
      ranges.push(range);
    }
    if (after?.nodeType === Node.TEXT_NODE && after.textContent?.startsWith("`")) {
      const range = document.createRange();
      range.setStart(after, 0);
      range.setEnd(after, 1);
      ranges.push(range);
    }
  }
  for (const range of ranges) highlight.add(range);
  ticksOf.set(root, ranges);
}
