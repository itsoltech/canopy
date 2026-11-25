import { diffWordsWithSpace, formatPatch, OMIT_HEADERS, structuredPatch, type Change } from "diff";

// The clients render each patch row. Keep large rewrites inspectable as source.
const MAX_DIFF_LINES = 3_000;
const MAX_DIFF_CHARS = 300_000;

export function unifiedTextDiff(before: string, after: string, context = 3) {
  if (before === after) return { kind: "text" as const, diff: "" };

  const patch = structuredPatch("", "", before, after, undefined, undefined, { context, timeout: 100 });

  if (!patch || patch.hunks.reduce((count, hunk) => count + hunk.lines.length + 1, 0) > MAX_DIFF_LINES)
    return { kind: "large" as const };

  const diff = formatPatch(patch, OMIT_HEADERS).replace(/\n$/, "");

  return diff.length > MAX_DIFF_CHARS ? { kind: "large" as const } : { kind: "text" as const, diff };
}

export type WordChange = Change;

export function replacedWords(before: string, after: string): WordChange[] | undefined {
  const words = diffWordsWithSpace(before, after, { maxEditLength: 64 });

  // Whole-line replacements already have a distinct background.
  if (!words?.some((word) => !word.added && !word.removed && /\S/u.test(word.value))) return undefined;

  return words;
}
