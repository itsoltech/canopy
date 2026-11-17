import type { SkillFile } from "@canopy/contracts";
import { skillManifestDigest } from "@canopy/domain/skill-artifact";

/** Windows file modes cannot retain executable bits; approved artifact digests remain canonical. */
export function installedSkillDigest(
  files: readonly Pick<SkillFile, "path" | "checksum" | "executable">[],
  platform: NodeJS.Platform = process.platform,
): string {
  return skillManifestDigest(platform === "win32" ? files.map((file) => ({ ...file, executable: false })) : files);
}
