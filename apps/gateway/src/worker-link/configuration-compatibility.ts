import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  Provider,
  ProviderConfigurationMode,
  WorkerConfigSchema,
  type ConfigApplied,
  type ProviderProfileConfig,
} from "@canopy/contracts";
import { CLAUDE_USER_CONFIGURATION_CAPABILITY } from "@canopy/domain/release/protocol";

const UPDATE_REQUIRED = "Update this worker to use local or shared Claude configuration.";

export function hasClaudeUserConfiguration(config: MessageInitShape<typeof WorkerConfigSchema>): boolean {
  return (config.profiles ?? []).some(
    (profile) =>
      !profile.disabled &&
      (!profile.providers?.length || profile.providers.includes(Provider.CLAUDE)) &&
      (profile.userConfiguration?.mode === ProviderConfigurationMode.LOCAL ||
        profile.userConfiguration?.mode === ProviderConfigurationMode.SHARED),
  );
}

/** Keep legacy workers available without silently changing an owner's requested configuration policy. */
export class WorkerConfigurationCompatibility {
  readonly supported: boolean;
  #blocked: { version: bigint; profiles: ProviderProfileConfig[] } | undefined;

  constructor(capabilities: readonly string[]) {
    this.supported = capabilities.includes(CLAUDE_USER_CONFIGURATION_CAPABILITY);
  }

  prepare(input: MessageInitShape<typeof WorkerConfigSchema>) {
    const config = create(WorkerConfigSchema, input);

    if (this.supported) return config;
    const profiles = config.profiles.filter((profile) => hasClaudeUserConfiguration({ profiles: [profile] }));
    this.#blocked = { version: config.version, profiles };

    return {
      ...config,
      profiles: config.profiles.map((profile) =>
        profiles.includes(profile) ? { ...profile, disabled: true } : profile,
      ),
    };
  }

  report(report: ConfigApplied): ConfigApplied {
    const blocked = this.#blocked;

    if (!blocked || blocked.version !== report.version || !blocked.profiles.length) return report;

    return {
      ...report,
      profiles: report.profiles.map((profile) =>
        blocked.profiles.some((p) => p.id === profile.id && profile.providers.includes(Provider.CLAUDE))
          ? { ...profile, available: false, detail: UPDATE_REQUIRED }
          : profile,
      ),
    };
  }
}
