import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { MentionKind } from "@canopy/contracts";
import type { MentionEntryInit } from "../../mentions/catalog.ts";
import type { NativeToolPolicy } from "../native-tools.ts";

type EntryInit = MentionEntryInit;

/**
 * What Claude Code offers the composer (docs/claude-adapter.md, "Wzmianki"). The list is Claude Code's own:
 * `Query.supportedCommands()` of a process started like a turn's (the thread's folder, the isolated config dir,
 * settingSources project + local), without a prompt, so the model is never called. Claude Code treats skills as
 * slash commands; its rows only say whether a command is built in, so:
 *
 * - a row whose name is a skill folder found on disk (`.claude/skills/<name>/SKILL.md` in the thread's folder or its
 *   parents, or `skills/` of the config dir) is a skill (SKILL, "$" in the composer), the rest are commands ("/"),
 * - built-in rows that make no sense in a platform thread are left out: terminal and session controls the platform
 *   owns (model, effort, clear, rename, ...), and the native subagent and scheduling features the platform replaces
 *   (unless the worker turns those on); "/goal" is the platform's own command (goals are tracked by the gateway),
 * - plugins: none. Platform threads load no Claude Code plugins and only the platform's MCP servers.
 *
 * The device owner's own skills (~/.claude/skills) are not visible: Claude runs with an isolated CLAUDE_CONFIG_DIR
 * and without user settings. Project skills in the repository are.
 */

/** Built-in commands that control the terminal, the session or settings the platform owns. */
const HIDDEN = new Set([
  "clear",
  "color",
  "focus",
  "heapdump",
  "rename",
  "model",
  "effort",
  "fast",
  "config",
  "mcp",
  "reload-plugins",
  "output-style",
  "autocompact",
  "auto-mode-setup",
  "design",
  "design-consent",
  "design-revoke",
  "design-sync",
  "team-onboarding",
  "insights",
  "doctor",
  "update-config",
  "plugin-authoring",
  "workflow-launch-exec",
  "goal",
]);

/** Built-in commands that run Claude Code's own subagents or workflows (off: side threads replace them). */
const SUBAGENT_COMMANDS = new Set(["agents", "list-agents", "batch", "deep-research", "workflow-authoring"]);

/** Built-in commands that schedule (off: platform schedules replace them). */
const SCHEDULING_COMMANDS = new Set(["loop"]);

export interface SkillOnDisk {
  readonly path: string;
  readonly source: "project" | "user";
}

/** Skill folders Claude Code would load for this folder: project ones (nearest first), then the config dir's. */
export function claudeSkillsOnDisk(cwd: string, configDir: string): Map<string, SkillOnDisk> {
  const skills = new Map<string, SkillOnDisk>();

  const add = (dir: string, source: SkillOnDisk["source"]) => {
    let names: string[];

    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      const file = join(dir, name, "SKILL.md");

      if (!skills.has(name) && existsSync(file)) skills.set(name, { path: file, source });
    }
  };

  for (let dir = cwd; ; dir = dirname(dir)) {
    add(join(dir, ".claude", "skills"), "project");

    if (dirname(dir) === dir) break;
  }

  add(join(configDir, "skills"), "user");

  return skills;
}

/** Newest change time of the folders the listing depends on (the cache key: a new skill or command shows up). */
export function claudeCatalogStamp(cwd: string, configDir: string): string {
  const dirs = [join(configDir, "skills"), join(configDir, "commands")];

  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(join(dir, ".claude", "skills"), join(dir, ".claude", "commands"));

    if (dirname(dir) === dir) break;
  }

  return dirs
    .map((dir) => {
      try {
        return statSync(dir).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(",");
}

export function claudeCatalogEntries(
  commands: readonly SlashCommand[],
  skills: ReadonlyMap<string, SkillOnDisk>,
  policy: NativeToolPolicy,
): EntryInit[] {
  const entries: EntryInit[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    if (seen.has(command.name) || command.name.startsWith("_")) continue;

    if (command.builtin) {
      if (HIDDEN.has(command.name)) continue;

      if (!policy.nativeSubagents && SUBAGENT_COMMANDS.has(command.name)) continue;

      if (!policy.nativeScheduling && SCHEDULING_COMMANDS.has(command.name)) continue;
    }

    seen.add(command.name);
    // Claude Code ends a non-built-in description with where it came from: "… (project)", "… (user)".
    const origin = /\s\((project|user|plugin[^)]*|[\w.-]+:[\w.-]+)\)$/.exec(command.description);
    const description = origin ? command.description.slice(0, origin.index) : command.description;
    const skill = command.builtin ? undefined : skills.get(command.name);

    const source = command.builtin
      ? "built-in"
      : (skill?.source ??
        (origin?.[1]?.startsWith("plugin")
          ? "plugin"
          : (origin?.[1] ?? (command.name.startsWith("mcp__") ? "mcp" : "user"))));

    entries.push({
      kind: skill ? MentionKind.SKILL : MentionKind.COMMAND,
      name: command.name,
      description,
      argumentHint: command.argumentHint,
      source,
      ...(skill && { path: skill.path }),
      aliases: command.aliases ?? [],
    });
  }

  return entries;
}

export const CLAUDE_CATALOG_NOTES = [
  "plugins: platform threads load no Claude Code plugins (isolated config dir)",
  "skills: the device owner's own skills (~/.claude/skills) are not loaded in platform threads; project skills are",
];
