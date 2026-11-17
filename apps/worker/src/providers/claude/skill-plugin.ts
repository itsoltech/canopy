import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { instructionDirectory } from "../../agent-environment/files.ts";
import { readSkillTree } from "../../agent-environment/skill-files.ts";

/** Explicit skill loading must not activate unapproved plugin hooks, MCP or other sibling components. */
export function claudeSkillPlugins(home: string): NonNullable<Options["plugins"]> {
  const path = join(home, "canopy-environment");
  instructionDirectory(path, false);
  let entries;

  try {
    entries = readdirSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  if (!entries.includes("skills")) return [];

  if (entries.some((name) => name !== "skills" && name !== ".in_use"))
    throw new Error("The Canopy skill plugin contains unmanaged components. Remove them before starting a session.");

  // Validate the reserved runtime directory too: metadata must not hide links or special files.
  if (entries.includes(".in_use")) readSkillTree(join(path, ".in_use"));
  instructionDirectory(join(path, "skills"), false);

  return [{ type: "local", path }];
}
