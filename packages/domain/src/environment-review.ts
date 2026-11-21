import type { SkillFile } from "@canopy/contracts";
import { formatPatch, OMIT_HEADERS, structuredPatch } from "diff";

// Both clients render the patch as individual rows. Keep large rewrites inspectable as source.
const MAX_DIFF_LINES = 3_000;
const MAX_DIFF_CHARS = 300_000;

/** Keep common context outside the changed block, including empty and trailing lines. */
export function textChanges(before: string, after: string) {
  const previous = before ? before.split("\n") : [];
  const next = after ? after.split("\n") : [];
  let start = 0;

  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = 0;

  while (
    end < previous.length - start &&
    end < next.length - start &&
    previous[previous.length - end - 1] === next[next.length - end - 1]
  )
    end++;

  return {
    removed: previous.slice(start, previous.length - end),
    added: next.slice(start, next.length - end),
    line: start + 1,
  };
}

function decodeFile(file: SkillFile): string | undefined {
  if (file.content.includes(0)) return;

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content);
  } catch {
    return undefined;
  }
}

export function environmentFileText(file?: SkillFile): string {
  if (!file) return "(File absent)";
  const checksum = file.checksum ? ` · SHA-256 ${file.checksum}` : "";

  return decodeFile(file) ?? `(Binary file · ${file.content.length} bytes${checksum})`;
}

export function environmentFileDiff(before?: SkillFile, after?: SkillFile) {
  const mode =
    before && after && before.executable !== after.executable
      ? after.executable
        ? "Executable permission added."
        : "Executable permission removed."
      : "";

  const previous = before ? decodeFile(before) : "";
  const next = after ? decodeFile(after) : "";

  if (previous === undefined || next === undefined) return { kind: "binary" as const, mode };

  if (previous === next) return { kind: "text" as const, mode, diff: "" };

  const patch = structuredPatch("", "", previous, next, undefined, undefined, { context: 3, timeout: 100 });

  if (!patch || patch.hunks.reduce((count, hunk) => count + hunk.lines.length + 1, 0) > MAX_DIFF_LINES)
    return { kind: "large" as const, mode };

  const diff = formatPatch(patch, OMIT_HEADERS).replace(/\n$/, "");

  return diff.length > MAX_DIFF_CHARS ? { kind: "large" as const, mode } : { kind: "text" as const, mode, diff };
}
