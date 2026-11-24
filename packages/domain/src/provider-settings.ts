import type { Harness } from "./harnesses.ts";
import { Schema } from "effect";
import { checkProviderSettingsText } from "./provider-settings-editor.ts";
import { parseClaudeProviderSettings, type ClaudeProviderSettings } from "./provider-settings-json.ts";

export type { ClaudeProviderSettings } from "./provider-settings-json.ts";

const optional = Schema.optionalKey;
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const CodexSettings = Schema.Struct({
  model_reasoning_effort: optional(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"])),
  model_reasoning_summary: optional(Schema.Literals(["auto", "concise", "detailed", "none"])),
  model_verbosity: optional(Schema.Literals(["low", "medium", "high"])),
  model_context_window: optional(PositiveInt),
  model_auto_compact_token_limit: optional(PositiveInt),
});

const GrokSettings = Schema.Struct({
  models: optional(
    Schema.Struct({
      default_reasoning_effort: optional(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"])),
      max_completion_tokens: optional(PositiveInt),
    }),
  ),
  session: optional(
    Schema.Struct({
      auto_compact_threshold_percent: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
    }),
  ),
});

const readCodexSettings = Schema.decodeUnknownSync(CodexSettings, { onExcessProperty: "error" });
const readGrokSettings = Schema.decodeUnknownSync(GrokSettings, { onExcessProperty: "error" });

export type CodexProviderSettings = typeof CodexSettings.Type;

export type GrokProviderSettings = typeof GrokSettings.Type;

export function parseProviderSettings(harness: "claude", source: string): ClaudeProviderSettings;
export function parseProviderSettings(harness: "codex", source: string): CodexProviderSettings;
export function parseProviderSettings(harness: "grok", source: string): GrokProviderSettings;
export function parseProviderSettings(
  harness: Harness,
  source: string,
): ClaudeProviderSettings | CodexProviderSettings | GrokProviderSettings;
export function parseProviderSettings(
  harness: Harness,
  source: string,
): ClaudeProviderSettings | CodexProviderSettings | GrokProviderSettings {
  if (harness === "claude") return parseClaudeProviderSettings(source);
  checkProviderSettingsText(source);

  if (!source.trim()) return {};

  if (harness === "antigravity") throw new Error("Antigravity does not support custom CLI settings.");

  let value: unknown;

  try {
    value = Bun.TOML.parse(source);
  } catch {
    throw new Error("Could not read config.toml. Check the TOML syntax and try again.");
  }

  try {
    return harness === "grok" ? readGrokSettings(value) : readCodexSettings(value);
  } catch {
    // Parser errors can carry user-pasted values, including secrets from a device's CLI file.
    throw new Error("Could not use config.toml. Check the supported keys and value formats.");
  }
}
