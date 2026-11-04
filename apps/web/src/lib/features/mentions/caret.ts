import { blockOf, elementOf } from "./editor.ts";

/**
 * Caret plumbing of the mention editor (Selection and Range over its contenteditable root), apart from the component
 * so MentionEditor reads as behaviour: what is before the caret, select back to a trigger, put the caret somewhere.
 */

const selection = () => getSelection();

function select(range: Range): void {
  const current = selection();
  current?.removeAllRanges();
  current?.addRange(range);
}

/** Text before a collapsed caret in the run of text nodes it sits in (a chip or a line break ends the run). */
export function textBeforeCaret(root: HTMLElement): string | undefined {
  const current = selection();

  if (!current || !current.isCollapsed || current.rangeCount === 0) return undefined;
  const node = current.anchorNode;

  if (!node || !root.contains(node) || node.nodeType !== Node.TEXT_NODE) return undefined;
  let before = (node.textContent ?? "").slice(0, current.anchorOffset);

  for (let prev = node.previousSibling; prev && prev.nodeType === Node.TEXT_NODE; prev = prev.previousSibling)
    before = (prev.textContent ?? "") + before;

  return before;
}

/** Selects the `length` characters before the caret (across the text nodes of its run). False when they are not there. */
export function selectBackFromCaret(length: number): boolean {
  const current = selection();

  if (!current || current.rangeCount === 0) return false;
  const range = current.getRangeAt(0).cloneRange();
  let node: Node | null = range.startContainer;
  let offset = range.startOffset;
  let left = length;

  while (node && left > offset) {
    left -= offset;
    node = node.previousSibling;
    offset = node?.textContent?.length ?? 0;
  }

  if (!node) return false;
  range.setStart(node, offset - left);
  select(range);

  return true;
}

/** The chip right before a collapsed caret, if any. */
export function chipBeforeCaret(root: HTMLElement): Element | undefined {
  const current = selection();

  if (!current?.isCollapsed || current.rangeCount === 0) return undefined;
  const node = current.anchorNode;

  if (!node || !root.contains(node)) return undefined;

  const prev =
    node.nodeType === Node.TEXT_NODE
      ? current.anchorOffset > 0
        ? null
        : node.previousSibling
      : node.childNodes[current.anchorOffset - 1];

  return prev instanceof HTMLElement && elementOf(prev) ? prev : undefined;
}

/** Selects a whole node (a chip, to delete it as one edit). */
export function selectNode(node: Node): void {
  const range = document.createRange();
  range.selectNode(node);
  select(range);
}

/** The caret after a node and the first character that follows it (an inserted chip and its space). */
export function caretAfter(node: Node): void {
  const range = document.createRange();
  const after = node.nextSibling;

  if (after?.nodeType === Node.TEXT_NODE) range.setStart(after, Math.min(1, after.textContent?.length ?? 0));
  else range.setStartAfter(node);
  range.collapse(true);
  select(range);
}

/** A caret inside `root`: the current one, else at the end. */
export function ensureCaret(root: HTMLElement): void {
  const current = selection();

  if (current && current.rangeCount > 0 && root.contains(current.anchorNode)) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  select(range);
}

/** The caret where something was dropped (when the browser can tell). */
export function caretAtPoint(root: HTMLElement, x: number, y: number): void {
  // Not in every browser yet (Safari before 18.2).
  const point = "caretPositionFromPoint" in document ? document.caretPositionFromPoint(x, y) : null;

  if (!point || !root.contains(point.offsetNode)) return;
  const range = document.createRange();
  range.setStart(point.offsetNode, point.offset);
  select(range);
}

const isBlock = (node: Node | null | undefined): node is HTMLElement =>
  node instanceof HTMLElement && blockOf(node) !== undefined;

/**
 * The code block right before a collapsed caret at the start of its line (Backspace there would delete the block
 * whole), or right after one at the end of its line (Delete, ArrowDown).
 */
export function blockBesideCaret(
  root: HTMLElement,
  side: "before" | "after",
  anywhere = false,
): HTMLElement | undefined {
  const current = selection();

  if (!current?.isCollapsed || current.rangeCount === 0) return undefined;
  const node = current.anchorNode;
  const offset = current.anchorOffset;

  if (!node || !root.contains(node)) return undefined;

  if (node.nodeType === Node.TEXT_NODE) {
    const data = node.textContent ?? "";
    // `anywhere`: the caret is on that line, at any column (ArrowUp / ArrowDown); else at its edge.
    const before = data.slice(0, offset).replace(/\u200b/g, "");

    if (side === "before")
      return (anywhere ? !before.includes("\n") : before === "") && isBlock(node.previousSibling)
        ? node.previousSibling
        : undefined;
    // The rest of the line: empty (or anything, `anywhere`), then its line break, then the block.
    const rest = data.slice(offset);
    const cut = rest.indexOf("\n");

    if (cut >= 0) {
      if (cut !== rest.length - 1 || (!anywhere && cut !== 0)) return undefined;

      return isBlock(node.nextSibling) ? node.nextSibling : undefined;
    }

    if (!anywhere && rest !== "") return undefined;
    let next = node.nextSibling;

    if (next?.nodeName === "BR") next = next.nextSibling;

    return isBlock(next) ? next : undefined;
  }

  if (side === "before") {
    const prev = node.childNodes[offset - 1];

    return isBlock(prev) ? prev : undefined;
  }

  let next: Node | null | undefined = node.childNodes[offset];

  if (next?.nodeName === "BR") next = next.nextSibling;

  return isBlock(next) ? next : undefined;
}

/**
 * The opening fence the caret's line is (`` ``` `` or `` ```ts ``, the caret at its end, nothing else on the line),
 * with how far back it reaches and what ends the line after it (to take along when the block replaces the line).
 */
export function fenceLineAtCaret(
  root: HTMLElement,
): { line: string; lineBreak: { node: Node; offset: number } | Node | undefined } | undefined {
  const current = selection();

  if (!current?.isCollapsed || current.rangeCount === 0) return undefined;
  const node = current.anchorNode;

  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node) || node.parentNode !== root) return undefined;
  const before = textBeforeCaret(root) ?? "";
  const cut = before.lastIndexOf("\n");
  const line = before.slice(cut + 1);

  if (!/^`{3,}[^`\s]*$/.test(line)) return undefined;

  // The line starts at a line break, a block or the start: not after a chip.
  if (cut < 0) {
    let first: Node = node;

    for (let prev = node.previousSibling; prev && prev.nodeType === Node.TEXT_NODE; prev = prev.previousSibling)
      first = prev;
    const prev = first.previousSibling;

    if (prev && prev.nodeName !== "BR" && !isBlock(prev)) return undefined;
  }

  const data = node.textContent ?? "";
  const offset = current.anchorOffset;
  const rest = data.slice(offset);

  if (rest.length > 0 && !rest.startsWith("\n")) return undefined;

  if (rest.startsWith("\n")) return { line, lineBreak: { node, offset: offset + 1 } };
  const next = node.nextSibling;

  if (next && next.nodeName !== "BR" && !isBlock(next)) return undefined;

  return { line, lineBreak: next?.nodeName === "BR" ? next : undefined };
}

/** The caret on the line next to a block: the end of the line before it, or the start of the line after it. */
export function caretBesideBlock(block: HTMLElement, side: "before" | "after"): boolean {
  const range = document.createRange();

  if (side === "after") {
    let next = block.nextSibling;

    if (!next || isBlock(next)) {
      // No line after it (or another block): one to write on, outside the undo history like a caret.
      next = document.createElement("br");
      block.after(next);
    }

    if (next.nodeType === Node.TEXT_NODE) range.setStart(next, 0);
    else range.setStartBefore(next);
  } else {
    const prev = block.previousSibling;

    if (!prev || isBlock(prev)) return false;

    if (prev.nodeType === Node.TEXT_NODE) {
      const data = prev.textContent ?? "";
      range.setStart(prev, data.endsWith("\n") ? data.length - 1 : data.length);
    } else if (prev.nodeName === "BR") range.setStartBefore(prev);
    else range.setStartAfter(prev);
  }

  range.collapse(true);
  select(range);

  return true;
}

/** Whether the caret's line box touches `block` (from above: `"after"`), so ArrowUp / ArrowDown would pass it. */
export function caretNextToBlock(block: HTMLElement, side: "before" | "after"): boolean {
  const current = selection();

  if (!current || current.rangeCount === 0) return false;
  const caret = current.getRangeAt(0).getBoundingClientRect();

  if (caret.height === 0) return true; // An empty line has no box: the logical neighbour is it.
  const box = block.getBoundingClientRect();

  return side === "after" ? box.top - caret.bottom < caret.height * 0.75 : caret.top - box.bottom < caret.height * 0.75;
}
