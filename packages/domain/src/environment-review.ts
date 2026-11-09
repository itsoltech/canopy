import type { SkillFile } from "@canopy/contracts";

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

export function environmentFileText(file?: SkillFile): string {
  if (!file) return "(File absent)";

  try {
    if (file.content.includes(0)) return `(Binary file · ${file.content.length} bytes)`;

    return new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  } catch {
    return `(Binary file · ${file.content.length} bytes · SHA-256 ${file.checksum})`;
  }
}
