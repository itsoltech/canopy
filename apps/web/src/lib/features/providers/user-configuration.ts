import { Provider, ProviderConfigurationMode, type ProviderUserConfiguration } from "@canopy/contracts";
import { codexHomeModes } from "@canopy/domain/provider-instances";

export interface UserConfigurationDraft {
  mode: ProviderConfigurationMode;
  sourcePath: string;
  instructions: boolean;
  skills: boolean;
  hooks: boolean;
}

export const configurationDraftOf = (value?: ProviderUserConfiguration): UserConfigurationDraft => ({
  mode: value?.mode || ProviderConfigurationMode.ISOLATED,
  sourcePath: value?.sourcePath ?? "",
  instructions: value?.instructions ?? false,
  skills: value?.skills ?? false,
  hooks: value?.hooks ?? false,
});

export function configurationInput(harness: Provider, value: UserConfigurationDraft | undefined) {
  if (!value) return undefined;

  if (harness === Provider.CODEX)
    return { mode: value.mode === ProviderConfigurationMode.SHARED ? value.mode : ProviderConfigurationMode.ISOLATED };

  return harness === Provider.CLAUDE ? { ...value, sourcePath: value.sourcePath.trim() } : undefined;
}

export const configurationModes = [
  { value: "isolated", label: "Isolated", mode: ProviderConfigurationMode.ISOLATED },
  { value: "local", label: "Use local configuration", mode: ProviderConfigurationMode.LOCAL },
  { value: "shared", label: "Share a directory", mode: ProviderConfigurationMode.SHARED },
] as const;

/** Mode changes start with safe import defaults; a stored explicit choice is preserved on load. */
export function selectConfiguration(
  selection: string,
  previous: UserConfigurationDraft | undefined,
  codex: boolean,
): UserConfigurationDraft | undefined {
  const modes = codex ? codexHomeModes : configurationModes;
  const mode = modes.find((option) => option.value === selection)?.mode;

  if (mode === undefined) return undefined;

  if (codex) return { ...configurationDraftOf(), mode };

  return {
    mode,
    sourcePath: previous?.sourcePath ?? "",
    instructions: mode !== ProviderConfigurationMode.ISOLATED,
    skills: mode !== ProviderConfigurationMode.ISOLATED,
    hooks: false,
  };
}
