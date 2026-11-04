import type { SkillArtifact, SkillFile } from "@canopy/contracts";

/** Scripts can execute without an executable bit when a harness invokes an interpreter. */
export const skillScript = (file: SkillFile): boolean =>
  file.executable ||
  /(^|\/)(scripts|hooks|bin)(\/|$)/i.test(file.path) ||
  /\.(sh|bash|zsh|fish|ps1|bat|cmd|js|mjs|cjs|ts|tsx|jsx|py|rb|pl|php|exe|dll|so|dylib|wasm)$/i.test(file.path) ||
  /(^|\/)(package\.json|Makefile|Dockerfile|.*lock.*)$/i.test(file.path) ||
  (file.content[0] === 35 && file.content[1] === 33);

export function skillChanges(before: SkillArtifact, after: SkillArtifact) {
  const paths = [...new Set([...before.files, ...after.files].map((f) => f.path))].sort();

  return paths.flatMap((path) => {
    const previous = before.files.find((f) => f.path === path);
    const next = after.files.find((f) => f.path === path);

    if (previous?.checksum === next?.checksum && previous?.executable === next?.executable) return [];

    return [
      {
        path,
        kind: !previous ? "added" : !next ? "removed" : "modified",
        script: Boolean((previous && skillScript(previous)) || (next && skillScript(next))),
      },
    ];
  });
}

export function canAutoUpdate(before: SkillArtifact, after: SkillArtifact): boolean {
  return before.name === after.name && skillChanges(before, after).every((f) => !f.script);
}
