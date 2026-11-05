import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../profiles.ts";

/** Codex 0.164's skills extension still requests host discovery when skip_host_skill_discovery is set. */
export function deviceSkillOverrides(env: Env): string[] {
  const root = join(env["HOME"] || env["USERPROFILE"] || homedir(), ".agents", "skills");

  if (!existsSync(root)) return [];
  const paths = new Bun.Glob("**/SKILL.md").scanSync({ cwd: root, absolute: true, followSymlinks: true });
  // Native path selectors disable device skills without disabling library, project or plugin skills.
  const rules = [...paths].map((path) => `{path=${JSON.stringify(realpathSync(path))},enabled=false}`);

  return rules.length ? ["-c", `skills.config=[${rules.join(",")}]`] : [];
}
