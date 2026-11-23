import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  DeviceLogin,
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  WorkerConfigSchema,
  type ConfigApplied,
  type ProviderProfileConfig,
} from "@canopy/contracts";
import {
  CLAUDE_USER_CONFIGURATION_CAPABILITY,
  CODEX_CLI_HOME_CAPABILITY,
  PROVIDER_SETTINGS_CAPABILITY,
} from "@canopy/domain/release/protocol";

const CLAUDE_UPDATE_REQUIRED = "Update this worker to use local or shared Claude configuration.";
const SETTINGS_UPDATE_REQUIRED = "Update this worker to use this instance's provider settings.";

type ProfileInput = NonNullable<MessageInitShape<typeof WorkerConfigSchema>["profiles"]>[number];

function hasClaudeUserConfiguration(profile: ProfileInput): boolean {
  return (
    (!profile.providers?.length || profile.providers.includes(Provider.CLAUDE)) &&
    (profile.userConfiguration?.mode === ProviderConfigurationMode.LOCAL ||
      profile.userConfiguration?.mode === ProviderConfigurationMode.SHARED)
  );
}

function hasCodexCliHome(profile: ProfileInput): boolean {
  return (
    profile.kind === ProviderProfileKind.NATIVE &&
    !profile.ownLogin &&
    profile.providers?.includes(Provider.CODEX) === true &&
    profile.userConfiguration?.mode === ProviderConfigurationMode.SHARED
  );
}

const hasProviderSettings = (profile: ProfileInput): boolean =>
  Boolean(profile.settingsText || profile.settingsOverrideText);

export function needsConfigurationNegotiation(config: MessageInitShape<typeof WorkerConfigSchema>): boolean {
  return (config.profiles ?? []).some(
    (profile) =>
      !profile.disabled &&
      (hasClaudeUserConfiguration(profile) ||
        (config.codex?.deviceLogin !== DeviceLogin.NONE && hasCodexCliHome(profile)) ||
        hasProviderSettings(profile)),
  );
}

type BlockedProfile = { id: string; providers: Provider[]; detail: string };

/** Keep legacy workers available without silently changing an owner's requested configuration policy. */
export class WorkerConfigurationCompatibility {
  readonly #supportsClaudeUserConfiguration: boolean;
  readonly #supportsCodexCliHome: boolean;
  readonly #supportsProviderSettings: boolean;
  #blocked: { version: bigint; profiles: BlockedProfile[] } | undefined;

  constructor(capabilities: readonly string[]) {
    this.#supportsClaudeUserConfiguration = capabilities.includes(CLAUDE_USER_CONFIGURATION_CAPABILITY);
    this.#supportsCodexCliHome = capabilities.includes(CODEX_CLI_HOME_CAPABILITY);
    this.#supportsProviderSettings = capabilities.includes(PROVIDER_SETTINGS_CAPABILITY);
  }

  prepare(input: MessageInitShape<typeof WorkerConfigSchema>) {
    const config = create(WorkerConfigSchema, input);

    const blocked: BlockedProfile[] = [];

    const profiles = config.profiles.map((configured) => {
      // Without device login Codex must use the private home, even on workers predating this option.
      const profile =
        config.codex?.deviceLogin === DeviceLogin.NONE && hasCodexCliHome(configured)
          ? { ...configured, userConfiguration: undefined }
          : configured;

      const incompatible = this.#incompatible(profile);

      if (!incompatible) return profile;
      blocked.push(incompatible);

      return { ...profile, disabled: true };
    });

    this.#blocked = { version: config.version, profiles: blocked };

    return { ...config, profiles };
  }

  #incompatible(profile: ProviderProfileConfig): BlockedProfile | undefined {
    if (profile.disabled) return undefined;

    if (!this.#supportsProviderSettings && hasProviderSettings(profile)) {
      return { id: profile.id, providers: profile.providers, detail: SETTINGS_UPDATE_REQUIRED };
    }

    if (!this.#supportsClaudeUserConfiguration && hasClaudeUserConfiguration(profile)) {
      return { id: profile.id, providers: [Provider.CLAUDE], detail: CLAUDE_UPDATE_REQUIRED };
    }

    if (!this.#supportsCodexCliHome && hasCodexCliHome(profile))
      return { id: profile.id, providers: [Provider.CODEX], detail: "Update this worker to use the Codex CLI home." };

    return undefined;
  }

  report(report: ConfigApplied): ConfigApplied {
    const blocked = this.#blocked;

    if (!blocked || blocked.version !== report.version || !blocked.profiles.length) return report;

    return {
      ...report,
      profiles: report.profiles.map((profile) => {
        const match = blocked.profiles.find(
          (p) =>
            p.id === profile.id &&
            (!p.providers.length || p.providers.some((provider) => profile.providers.includes(provider))),
        );

        return match ? { ...profile, available: false, detail: match.detail } : profile;
      }),
    };
  }
}
