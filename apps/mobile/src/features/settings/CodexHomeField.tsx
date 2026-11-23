import { create } from "@bufbuild/protobuf";
import {
  ProviderConfigurationMode,
  type ProviderUserConfiguration,
  ProviderUserConfigurationSchema,
} from "@canopy/contracts";
import { codexHomeDescription, codexHomeModes, defaultCodexHomeMode } from "@canopy/domain/provider-instances";
import { SettingChoice } from "./SettingsGroup";

export function CodexHomeField({
  instanceId,
  value,
  inherited,
  onChange,
}: {
  instanceId: string;
  value: ProviderUserConfiguration | undefined;
  inherited?: ProviderConfigurationMode;
  onChange: (value: ProviderUserConfiguration | undefined) => void;
}) {
  const defaultMode = defaultCodexHomeMode(instanceId);

  const inheritedLabel =
    inherited === undefined
      ? undefined
      : codexHomeModes.find((option) => option.mode === (inherited || defaultMode))?.label;

  return (
    <SettingChoice
      title="Codex home"
      description={codexHomeDescription}
      options={[
        ...(inheritedLabel
          ? [{ label: `Inherit definition (${inheritedLabel})`, value: ProviderConfigurationMode.UNSPECIFIED }]
          : []),
        ...codexHomeModes.map(({ label, mode, description }) => ({ label, value: mode, description })),
      ]}
      value={value?.mode || (inheritedLabel ? ProviderConfigurationMode.UNSPECIFIED : defaultMode)}
      onChange={(mode) => onChange(mode ? create(ProviderUserConfigurationSchema, { mode }) : undefined)}
    />
  );
}
