import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./profiles.ts";
import { Effect, Option, Schema } from "effect";
import { isString } from "./json.ts";

// Invalid settings are ignored independently, so they cannot hide a valid global fallback.
function optionalSetting<S extends Schema.Top>(schema: S) {
  return Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))));
}

const SettingText = optionalSetting(Schema.String);
const EffortSettings = optionalSetting(Schema.Struct({ effortLevel: Schema.optionalKey(SettingText) }));

const ClaudeSettings = Schema.Struct({
  effortLevel: Schema.optionalKey(SettingText),
  modelSettings: Schema.optionalKey(optionalSetting(Schema.Record(Schema.String, EffortSettings))),
});

const CodexSettings = Schema.Struct({
  profile: Schema.optionalKey(SettingText),
  model_reasoning_effort: Schema.optionalKey(SettingText),
  profiles: Schema.optionalKey(
    optionalSetting(
      Schema.Record(
        Schema.String,
        optionalSetting(
          Schema.Struct({
            model_reasoning_effort: Schema.optionalKey(SettingText),
          }),
        ),
      ),
    ),
  ),
});

/**
 * The reasoning effort the device owner set as their default in each harness (docs/protocol.md#modele-effort-i-steer).
 * Platform threads run with isolated homes (home.ts) and Claude without user settings, so the harnesses do not
 * read these files themselves: the worker reads them, reports the value as `ModelInfo.default_effort` and sends
 * it with a turn that has no effort of its own. The files are only read, never written.
 *
 * - Codex (`$CODEX_HOME/config.toml`, else ~/.codex/config.toml): `model_reasoning_effort` of the profile chosen by
 *   the top-level `profile`, else the top-level `model_reasoning_effort`. Project `.codex/config.toml`, system and
 *   managed layers are not read (the catalog is per worker, not per folder).
 * - Claude Code: `CLAUDE_CODE_EFFORT_LEVEL` of the worker's environment (Claude Code gets it too and it wins over
 *   every other source there; `auto` / `unset` = the model's own default), else `~/.claude/settings.json`
 *   (`$CLAUDE_CONFIG_DIR/settings.json`): `modelSettings.<model>.effortLevel` (what `/effort` saves), else
 *   `effortLevel`. Project and local settings depend on the folder and are not read for the catalog.
 */

/** A level the model offers: the configured one, else the model's own default, else none. */
export function pickDefaultEffort(
  efforts: readonly string[],
  configured: string | undefined,
  modelDefault?: string,
): string | undefined {
  if (configured && efforts.includes(configured)) return configured;

  return modelDefault && efforts.includes(modelDefault) ? modelDefault : undefined;
}

/** Codex config.toml text → its default effort. Unreadable TOML = none. */
export function codexConfiguredEffort(configToml: string): string | undefined {
  let config: typeof CodexSettings.Type;

  try {
    config = Schema.decodeUnknownSync(CodexSettings)(Bun.TOML.parse(configToml));
  } catch {
    return undefined;
  }

  const profile = config.profile ? config.profiles?.[config.profile] : undefined;

  return text(profile?.["model_reasoning_effort"]) ?? text(config["model_reasoning_effort"]);
}

export function readCodexConfiguredEffort(codexHome: string): string | undefined {
  const toml = readText(join(codexHome, "config.toml"));

  return toml === undefined ? undefined : codexConfiguredEffort(toml);
}

/**
 * Claude Code's default effort for a model, known by its names (id, alias target). `modelSettings` keys match
 * a name without the `[1m]` suffix and the date (`claude-sonnet-4-5-20250929` = `claude-sonnet-4-5`).
 */
export function claudeConfiguredEffort(
  settings: typeof ClaudeSettings.Type | undefined,
  env: Env,
  names: readonly string[],
): string | undefined {
  const fromEnv = env["CLAUDE_CODE_EFFORT_LEVEL"]?.trim().toLowerCase();

  if (fromEnv === "auto" || fromEnv === "unset") return undefined;

  if (fromEnv) return fromEnv;
  const user = settings;
  const wanted = new Set(names.flatMap((name) => (name ? [canonicalClaudeModel(name)] : [])));

  for (const [key, value] of Object.entries(user?.modelSettings ?? {})) {
    const level = text(value?.effortLevel);

    if (level && wanted.has(canonicalClaudeModel(key))) return level;
  }

  return text(user?.["effortLevel"]);
}

/** The device owner's Claude user settings; missing or invalid JSON = none. */
export function readClaudeUserSettings(claudeHome: string): typeof ClaudeSettings.Type | undefined {
  const json = readText(join(claudeHome, "settings.json"));

  if (json === undefined) return undefined;

  try {
    return Schema.decodeUnknownSync(ClaudeSettings)(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function canonicalClaudeModel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function text(value: string | undefined): string | undefined {
  return isString(value) && value.trim() ? value.trim().toLowerCase() : undefined;
}
