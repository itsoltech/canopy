import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { Schema } from "effect";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "../../git/refs.ts";
import { decodeJsonObject, isJsonObject } from "../json.ts";
import { readClaudeConfigurationFile } from "./user-configuration-files.ts";

const optional = Schema.optionalKey;
const Effort = Schema.Literals(["low", "medium", "high", "xhigh"]);
const Strings = Schema.mutable(Schema.Array(Schema.String));

const Attribution = Schema.Struct({
  commit: optional(Schema.String),
  pr: optional(Schema.String),
  sessionUrl: optional(Schema.Boolean),
});

const ModelPreferences = Schema.Struct({
  effortLevel: optional(Effort),
  autoCompactWindow: optional(Schema.Union([Schema.Literal("auto"), Schema.Number])),
});

const SpinnerTip = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  cooldownSessions: optional(Schema.Int),
  priority: optional(Schema.Number),
});

/** Reconstruct nested preferences: the SDK's Settings type permits arbitrary extra nested fields. */
const Preferences = Schema.Struct({
  attribution: optional(Schema.Union([Schema.Boolean, Attribution])),
  includeCoAuthoredBy: optional(Schema.Boolean),
  includeGitInstructions: optional(Schema.Boolean),
  language: optional(Schema.String),
  outputStyle: optional(Schema.String),
  effortLevel: optional(Effort),
  modelSettings: optional(Schema.Record(Schema.String, ModelPreferences)),
  alwaysThinkingEnabled: optional(Schema.Boolean),
  autoCompactWindow: optional(Schema.Number),
  autoCompactEnabled: optional(Schema.Boolean),
  precomputeCompactionEnabled: optional(Schema.Boolean),
  promptCacheTtl: optional(Schema.Literals(["5m", "1h"])),
  subagentPromptCacheTtl: optional(Schema.Literals(["5m", "1h"])),
  respectGitignore: optional(Schema.Boolean),
  spinnerTipsEnabled: optional(Schema.Boolean),
  spinnerVerbs: optional(Schema.Struct({ mode: Schema.Literals(["append", "replace"]), verbs: Strings })),
  spinnerTipsOverride: optional(
    Schema.Struct({
      excludeDefault: optional(Schema.Boolean),
      tips: optional(Schema.mutable(Schema.Array(Schema.Union([Schema.String, SpinnerTip])))),
      label: optional(Schema.String),
    }),
  ),
  syntaxHighlightingDisabled: optional(Schema.Boolean),
  maxProseWidth: optional(Schema.Number),
  promptSuggestionEnabled: optional(Schema.Boolean),
  emojiCompletionEnabled: optional(Schema.Boolean),
  showThinkingSummaries: optional(Schema.Boolean),
  showTurnDuration: optional(Schema.Boolean),
  showMessageTimestamps: optional(Schema.Boolean),
  prefersReducedMotion: optional(Schema.Boolean),
  verbose: optional(Schema.Boolean),
});

const decodePreferences = Schema.decodeUnknownSync(Preferences);

/** User preferences retain user precedence even though the SDK sends the merged result in its flag layer. */
export async function readClaudePreferences(sourceHome: string, cwd: string): Promise<Settings> {
  const root = await repoRoot(cwd);
  const localRoot = root && canonicalLocalRoot(root, cwd) ? root : cwd;

  const files = [
    join(sourceHome, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    ...(resolve(localRoot) !== resolve(cwd) ? [join(localRoot, ".claude", "settings.local.json")] : []),
  ];

  let merged: JsonObject = {};

  for (const file of files) merged = mergePreferences(merged, readPreferences(file));

  return decodePreferences(merged);
}

function readPreferences(path: string): JsonObject {
  try {
    const text = readClaudeConfigurationFile(path);

    return text === undefined ? {} : decodeJsonObject(decodePreferences(JSON.parse(text)));
  } catch {
    throw new Error(
      "Invalid Claude preferences. Use a regular UTF-8 settings file up to 1 MiB with valid preferences.",
    );
  }
}

function mergePreferences(lower: JsonObject, higher: JsonObject): JsonObject {
  const merged = { ...lower };

  for (const [key, value] of Object.entries(higher)) {
    // JSON object keys must never address Object.prototype while recursively merging.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const previous = merged[key];

    merged[key] = mergeValue(previous, value);
  }

  return merged;
}

function mergeValue(lower: JsonValue | undefined, higher: JsonValue): JsonValue {
  if (Array.isArray(lower) && Array.isArray(higher)) return [...new Set([...lower, ...higher])];

  if (lower && isJsonObject(lower) && isJsonObject(higher)) return mergePreferences(lower, higher);

  return higher;
}

/** Native CLI canonicalizes the local consent/settings store only to a repository owned by this OS user. */
function canonicalLocalRoot(root: string, cwd: string): boolean {
  if (resolve(root) === resolve(cwd) || process.platform === "win32") return false;
  const uid = process.geteuid?.() ?? process.getuid?.();

  if (uid === undefined) return false;

  try {
    if (realpathSync(homedir()) === realpathSync(root)) return false;

    if (statSync(root).uid !== uid || lstatSync(join(root, ".git")).uid !== uid) return false;

    try {
      return lstatSync(join(root, ".claude")).uid === uid;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ENOENT";
    }
  } catch {
    return false;
  }
}
