const cliSettings = {
  claude: {
    filename: "settings.json",
    format: "JSON",
    example: '{\n  "language": "Polish"\n}',
    keys: [
      "language",
      "effortLevel",
      "alwaysThinkingEnabled",
      "autoCompactEnabled",
      "autoCompactWindow",
      "includeCoAuthoredBy",
      "includeGitInstructions",
      "respectGitignore",
      "showThinkingSummaries",
      "attribution",
    ],
  },
  codex: {
    filename: "config.toml",
    format: "TOML",
    example: 'model_verbosity = "low"',
    keys: [
      "model_reasoning_effort",
      "model_reasoning_summary",
      "model_verbosity",
      "model_context_window",
      "model_auto_compact_token_limit",
    ],
  },
  grok: {
    filename: "config.toml",
    format: "TOML",
    example: "[session]\nauto_compact_threshold_percent = 85",
    keys: ["models.default_reasoning_effort", "models.max_completion_tokens", "session.auto_compact_threshold_percent"],
  },
} as const;

type CliSettingsHarness = keyof typeof cliSettings;

type CliSettingsEditor = (typeof cliSettings)[CliSettingsHarness];

export function providerSettingsEditor(harness: CliSettingsHarness): CliSettingsEditor;
export function providerSettingsEditor(harness: string): CliSettingsEditor | undefined;
export function providerSettingsEditor(harness: string): CliSettingsEditor | undefined {
  return harness === "claude" || harness === "codex" || harness === "grok" ? cliSettings[harness] : undefined;
}

const SETTINGS_BYTES = 16_384;

export function checkProviderSettingsText(source: string): void {
  // A UTF-16 unit takes at most three UTF-8 bytes. Skip encoding ordinary short drafts.
  if (
    source.length > SETTINGS_BYTES ||
    (source.length * 3 > SETTINGS_BYTES && new TextEncoder().encode(source).length > SETTINGS_BYTES)
  ) {
    throw new Error("CLI settings are too long. Use up to 16 KiB.");
  }

  // In Unicode mode the range matches lone UTF-16 surrogates, including on Hermes.
  if (source.includes("\0") || /[\uD800-\uDFFF]/u.test(source)) {
    throw new Error("CLI settings contain invalid text. Remove invalid characters and try again.");
  }
}
