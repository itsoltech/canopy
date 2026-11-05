import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnvironmentBlock } from "@canopy/domain/agent-environment";
import { readInstructionFile } from "../../agent-environment/files.ts";
import { repoRoot } from "../../git/refs.ts";
import type { Env } from "../profiles.ts";

/** settingSources excludes user settings, but Claude still discovers user memory and ancestors. */
export async function claudeInstructionSettings(
  cwd: string,
  scratch: boolean,
  home: string,
  env: Env,
): Promise<NonNullable<Options["settings"]>> {
  const root = realpathSync((scratch ? undefined : await repoRoot(cwd)) ?? cwd);
  const excludes = [literalPath(join(home, "CLAUDE.md"))];
  const deviceHome = env["HOME"] || env["USERPROFILE"];

  if (deviceHome) excludes.push(`${literalPath(join(deviceHome, ".claude"))}/**`);

  // Exclude exact ancestor files/directories, never the workspace or its descendants.
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    for (const file of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) excludes.push(literalPath(join(parent, file)));

    excludes.push(`${literalPath(join(parent, ".claude"))}/**`);

    if (dirname(parent) === parent) break;
  }

  return { claudeMdExcludes: excludes };
}

function literalPath(path: string): string {
  // Claude normalizes backslashes in patterns; character classes keep glob characters literal.
  return path.replaceAll("\\", "/").replace(/[*?[\]{}()]/g, "[$&]");
}

/** User settings stay disabled. Only the isolated home's managed instructions enter the platform prompt. */
export function managedClaudeInstructions(home: string): string {
  try {
    return readEnvironmentBlock(readInstructionFile(join(home, "CLAUDE.md")).text ?? "")?.content ?? "";
  } catch {
    return "";
  }
}
