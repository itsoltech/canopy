import { create } from "@bufbuild/protobuf";
import {
  ProviderConfigurationMode,
  type ProviderUserConfiguration,
  ProviderUserConfigurationSchema,
} from "@canopy/contracts";
import { codexHomeDescription, codexHomeModes } from "@canopy/domain/provider-instances";
import { SettingChoice } from "./SettingsGroup";

export function CodexHomeField({
  value,
  inherited,
  onChange,
}: {
  value: ProviderUserConfiguration | undefined;
  inherited?: ProviderConfigurationMode;
  onChange: (value: ProviderUserConfiguration | undefined) => void;
}) {
  const inheritedLabel = codexHomeModes.find((option) => option.mode === inherited)?.label;

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
      value={
        value?.mode || (inheritedLabel ? ProviderConfigurationMode.UNSPECIFIED : ProviderConfigurationMode.ISOLATED)
      }
      onChange={(mode) => onChange(mode ? create(ProviderUserConfigurationSchema, { mode }) : undefined)}
    />
  );
}
