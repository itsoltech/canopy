import { languageOfPath, type LanguageId } from "./languages.ts";

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "file";

export interface DiffLine {
  readonly text: string;
  readonly kind: DiffLineKind;
  /** The line's code: without its +/-/space sign in a diff. */
  readonly code: string;
  /** Index of the line's code in its side (`DiffSides`): the new side for add and ctx, the old for del. */
  readonly at: number;
}

export interface DiffSides {
  readonly lines: readonly DiffLine[];
  /** The code the diff leaves (context and added lines) and the code it replaces (context and removed), without the +/-/space prefix: each highlighted as one text, so a line continues the grammar state of the line before it. */
  readonly next: string;
  readonly old: string;
}

/**
 * A unified diff split into lines and into the two versions of the code. Lines before the first hunk
 * (`diff --git`, `index`, `---`/`+++`; again after each `diff --git`) and "\ No newline" are file lines; text without a hunk is all
 * context (it is not a diff).
 */
export function parseDiff(diff: string): DiffSides {
  const hunks = /^@@/m.test(diff);
  let inHunk = !hunks;
  const next: string[] = [];
  const old: string[] = [];
  const lines = diff
    .replace(/\n$/, "")
    .split("\n")
    .map((text): DiffLine => {
      if (text.startsWith("diff --git ")) inHunk = false;
      if (text.startsWith("@@")) {
        inHunk = true;
        return { text, kind: "hunk", code: text, at: -1 };
      }
      if (!inHunk || text.startsWith("\\")) return { text, kind: "file", code: text, at: -1 };
      const code = hunks ? text.slice(1) : text;
      if (hunks && text.startsWith("+")) return { text, kind: "add", code, at: next.push(code) - 1 };
      if (hunks && text.startsWith("-")) return { text, kind: "del", code, at: old.push(code) - 1 };
      old.push(code);
      return { text, kind: "ctx", code, at: next.push(code) - 1 };
    });
  return { lines, next: next.join("\n"), old: old.join("\n") };
}

/** The language of the file a diff names in its `+++ b/…` (or `--- a/…`) header. */
export function languageOfDiff(diff: string): LanguageId | undefined {
  for (const header of [/^\+\+\+ (?:b\/)?(\S+)/m, /^--- (?:a\/)?(\S+)/m]) {
    const path = header.exec(diff)?.[1];
    if (path && path !== "/dev/null") return languageOfPath(path);
  }
  return undefined;
}
