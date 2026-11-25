import type { SkillFile } from "@canopy/contracts";
import { unifiedTextDiff } from "./text-diff.ts";

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

  return { ...unifiedTextDiff(previous, next), mode };
}
