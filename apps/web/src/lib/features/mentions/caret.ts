import { elementOf } from "./editor.ts";

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
  for (let prev = node.previousSibling; prev && prev.nodeType === Node.TEXT_NODE; prev = prev.previousSibling) before = (prev.textContent ?? "") + before;
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
  const prev = node.nodeType === Node.TEXT_NODE ? (current.anchorOffset > 0 ? null : node.previousSibling) : node.childNodes[current.anchorOffset - 1];
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
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const point = doc.caretPositionFromPoint?.(x, y);
  if (!point || !root.contains(point.offsetNode)) return;
  const range = document.createRange();
  range.setStart(point.offsetNode, point.offset);
  select(range);
}
