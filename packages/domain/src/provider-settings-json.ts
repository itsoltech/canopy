import { Result, Schema } from "effect";
import { checkProviderSettingsText } from "./provider-settings-editor.ts";

const optional = Schema.optionalKey;
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const ShortText = Schema.String.check(Schema.isMaxLength(512));

const Attribution = Schema.Struct({
  commit: optional(ShortText),
  pr: optional(ShortText),
  sessionUrl: optional(Schema.Boolean),
});

const ClaudeSettings = Schema.Struct({
  language: optional(ShortText),
  effortLevel: optional(Schema.Literals(["low", "medium", "high", "xhigh"])),
  alwaysThinkingEnabled: optional(Schema.Boolean),
  autoCompactEnabled: optional(Schema.Boolean),
  autoCompactWindow: optional(PositiveInt),
  includeCoAuthoredBy: optional(Schema.Boolean),
  includeGitInstructions: optional(Schema.Boolean),
  respectGitignore: optional(Schema.Boolean),
  showThinkingSummaries: optional(Schema.Boolean),
  attribution: optional(Schema.Union([Schema.Boolean, Attribution])),
});

const readClaudeSettings = Schema.decodeUnknownResult(ClaudeSettings, { onExcessProperty: "error" });

export type ClaudeProviderSettings = typeof ClaudeSettings.Type;

/** The same JSON and schema checks on the client, gateway and worker. */
export function parseClaudeProviderSettings(source: string): ClaudeProviderSettings {
  checkProviderSettingsText(source);

  if (!source.trim()) return {};
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Could not read settings.json. Check the JSON syntax and try again.");
  }

  const decoded = readClaudeSettings(value);

  // Decoder details can contain pasted values.
  if (Result.isFailure(decoded)) {
    throw new Error("Could not use settings.json. Check the supported keys and value formats.");
  }

  return decoded.success;
}

export function claudeProviderSettingsProblem(source: string): string | undefined {
  try {
    parseClaudeProviderSettings(source);

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not read settings.json. Check the JSON syntax.";
  }
}
