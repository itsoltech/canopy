export const providerKeys = ["CLAUDE", "CODEX", "GROK", "ANTIGRAVITY"] as const;

export type ProviderKey = (typeof providerKeys)[number];

export const isProviderKey = (value: string): value is ProviderKey => providerKeys.some((key) => key === value);

export const antigravityDeviceLogin =
  "Run agy acp --login on the worker to sign in. You can also set GEMINI_API_KEY as a secret in Environment.";

export const automaticTextGenerationDescription =
  "Claude, Codex and Grok use a small, fast model from the thread’s instance at low effort when available. " +
  "They fall back to the thread’s model. For Antigravity threads, choose a text generation model.";
