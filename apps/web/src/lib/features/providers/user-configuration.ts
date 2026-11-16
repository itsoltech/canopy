import { ProviderConfigurationMode, type ProviderUserConfiguration } from "@canopy/contracts";

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

export const configurationInput = (value: UserConfigurationDraft): UserConfigurationDraft => ({
  ...value,
  sourcePath: value.sourcePath.trim(),
});

export const configurationModes = [
  { value: "isolated", label: "Isolated", mode: ProviderConfigurationMode.ISOLATED },
  { value: "local", label: "Use local configuration", mode: ProviderConfigurationMode.LOCAL },
  { value: "shared", label: "Share a directory", mode: ProviderConfigurationMode.SHARED },
] as const;

/** Mode changes start with safe import defaults; a stored explicit choice is preserved on load. */
export function selectConfiguration(
  selection: string,
  previous: UserConfigurationDraft | undefined,
): UserConfigurationDraft | undefined {
  const mode = configurationModes.find((option) => option.value === selection)?.mode;

  if (mode === undefined) return undefined;

  return {
    mode,
    sourcePath: previous?.sourcePath ?? "",
    instructions: mode !== ProviderConfigurationMode.ISOLATED,
    skills: mode !== ProviderConfigurationMode.ISOLATED,
    hooks: false,
  };
}
