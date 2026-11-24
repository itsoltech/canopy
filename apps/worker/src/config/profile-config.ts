import { Provider, ProviderProfileKind, type WorkerConfig } from "@canopy/contracts";
import { harnessOf, type Harness } from "@canopy/domain/harnesses";
import { parseProviderSettings, type GrokProviderSettings } from "@canopy/domain/provider-settings";
import type { ProviderProfileConfig } from "../providers/profiles.ts";

type WireProfile = WorkerConfig["profiles"][number];

/** Only resolved, canonical preferences enter the runtime snapshot. */
function profileSettings(profile: WireProfile) {
  const { settingsText, settingsOverrideText } = profile;

  if ((!settingsText && !settingsOverrideText) || profile.disabled) return {};
  const [provider] = profile.providers;

  if (profile.providers.length !== 1) return { problem: "CLI settings require a single provider." };

  try {
    if (provider === Provider.CLAUDE) {
      const claudeSettings = orderedSettings({
        ...parseProviderSettings("claude", settingsText),
        ...parseProviderSettings("claude", settingsOverrideText),
      });

      return Object.keys(claudeSettings).length ? { runtime: { claudeSettings } } : {};
    }

    if (provider === Provider.CODEX) {
      const codexSettings = orderedSettings({
        ...parseProviderSettings("codex", settingsText),
        ...parseProviderSettings("codex", settingsOverrideText),
      });

      return Object.keys(codexSettings).length ? { runtime: { codexSettings } } : {};
    }

    if (provider === Provider.GROK) {
      const grokSettings = mergeGrokSettings(
        parseProviderSettings("grok", settingsText),
        parseProviderSettings("grok", settingsOverrideText),
      );

      return Object.keys(grokSettings).length ? { runtime: { grokSettings } } : {};
    }

    return { problem: "CLI settings are available for Claude, Codex and Grok." };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : "Could not apply CLI settings." };
  }
}

function mergeGrokSettings(global: GrokProviderSettings, override: GrokProviderSettings): GrokProviderSettings {
  const models = orderedSettings({ ...global.models, ...override.models });
  const session = orderedSettings({ ...global.session, ...override.session });

  return {
    ...(Object.keys(models).length && { models }),
    ...(Object.keys(session).length && { session }),
  };
}

function orderedSettings<T extends object>(settings: T): T {
  // The same effective keys must compare equal even when moved between the global and worker documents.
  // SAFETY: The validated settings are plain objects. Sorting their entries preserves every key and value.
  return Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))) as T;
}

export function profileConfig(
  profile: WireProfile,
  index: number,
  issue: (path: string, message: string, fatal?: boolean) => void,
): ProviderProfileConfig | undefined {
  const { runtime: settings, problem: settingsProblem } = profileSettings(profile);
  const providers: Harness[] = [];

  for (const provider of profile.providers) {
    const harness = harnessOf(provider);

    if (harness) providers.push(harness);
    else issue(`profiles[${index}].providers`, `unsupported provider for "${profile.id}"`);
  }

  if (profile.providers.length && !providers.length) return undefined;

  const common = {
    id: profile.id,
    ...(providers.length && { providers }),
    ...(profile.displayName && { displayName: profile.displayName }),
    ...(profile.env.length > 0 && {
      env: profile.env.map((v) => ({ name: v.name, value: v.value, secret: v.secret })),
    }),
    ...(profile.disabled && { disabled: true }),
    ...(settingsProblem && { settingsProblem }),
    ...((profile.executablePath ||
      profile.homePath ||
      profile.shadowHomePath ||
      profile.launchArgs.length > 0 ||
      profile.ownLogin ||
      profile.userConfiguration ||
      settings) && {
      runtime: {
        ...settings,
        ...(profile.userConfiguration && {
          userConfiguration: {
            mode: profile.userConfiguration.mode,
            sourcePath: profile.userConfiguration.sourcePath,
            instructions: profile.userConfiguration.instructions,
            skills: profile.userConfiguration.skills,
            hooks: profile.userConfiguration.hooks,
          },
        }),
        ...(profile.executablePath && { executablePath: profile.executablePath }),
        ...(profile.homePath && { homePath: profile.homePath }),
        ...(profile.shadowHomePath && { shadowHomePath: profile.shadowHomePath }),
        ...(profile.launchArgs.length > 0 && { launchArgs: [...profile.launchArgs] }),
        ...(profile.ownLogin && { ownLogin: true }),
      },
    }),
  };

  switch (profile.kind) {
    case ProviderProfileKind.NATIVE:
      return { kind: "native", ...common };
    case ProviderProfileKind.CLIPROXYAPI:
      return {
        kind: "cliproxyapi",
        ...common,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        ...(profile.proxyCodex && { codex: profile.proxyCodex }),
      };
    default:
      issue(`profiles[${index}].kind`, `unsupported profile kind for "${profile.id}"`);

      return undefined;
  }
}
