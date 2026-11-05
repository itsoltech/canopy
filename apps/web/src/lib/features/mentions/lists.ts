import { lineBeforeCaret, selectBackFromCaret } from "./caret.ts";

/** What Shift+Enter does on a Markdown list line: start the next item, or end the list on an empty one. */
export type ListStep =
  | { readonly kind: "continue"; readonly marker: string }
  | { readonly kind: "end"; readonly length: number };

const ITEM = /^(\s*)(?:(\d{1,9})([.)])|([-*+]))( +)(.*)$/;

/**
 * The list step for the line before the caret: `1. a` continues with `2. `, `- a` with `- ` (same indent and
 * delimiter); an item with no text yet (`2. `) ends the list by removing its marker.
 */
export function listStep(line: string): ListStep | undefined {
  const match = ITEM.exec(line);

  if (!match) return undefined;
  const [, indent = "", number, delimiter = ".", bullet = "-", , rest = ""] = match;

  if (!rest.trim()) return { kind: "end", length: line.length };

  return { kind: "continue", marker: `${indent}${number ? `${Number(number) + 1}${delimiter}` : bullet} ` };
}

/** Shift+Enter in the editor: a line break that continues a Markdown list, or ends it on an empty item. */
export function breakLine(root: HTMLElement | undefined): void {
  const step = root ? listStep(lineBeforeCaret(root) ?? "") : undefined;

  if (step?.kind === "end" && selectBackFromCaret(step.length)) {
    document.execCommand("delete");

    return;
  }

  document.execCommand("insertLineBreak");

  if (step?.kind === "continue") document.execCommand("insertText", false, step.marker);
}
