import { create } from "@bufbuild/protobuf";
import {
  ProviderConfigurationMode as Mode,
  ProviderUserConfigurationSchema,
  type ProviderUserConfiguration,
} from "@canopy/contracts";
import { Field } from "../../ui/components";
import { SettingChoice, SettingToggle } from "./SettingsGroup";

const modes = [
  {
    value: Mode.ISOLATED,
    label: "Isolated",
    description: "Keep Claude settings and thread history in Canopy’s private directory.",
  },
  {
    value: Mode.LOCAL,
    label: "Use local configuration",
    description: "Use local settings and preferences while keeping thread history private.",
  },
  {
    value: Mode.SHARED,
    label: "Share a directory",
    description: "Share thread history with Claude Code in the source directory.",
  },
];

export function ClaudeConfigurationFields({
  value,
  inherited,
  onChange,
}: {
  value?: ProviderUserConfiguration;
  inherited?: ProviderUserConfiguration;
  onChange: (value: ProviderUserConfiguration | undefined) => void;
}) {
  const mode = value ? value.mode || Mode.ISOLATED : inherited ? Mode.UNSPECIFIED : Mode.ISOLATED;

  const inherit = inherited && {
    value: Mode.UNSPECIFIED,
    label: `Inherit definition (${modes.find((item) => item.value === inherited.mode)?.label ?? "Isolated"})`,
    description: "Use the configuration and source directory from the provider definition.",
  };

  const options = inherit ? [inherit, ...modes] : modes;

  function choose(next: Mode) {
    onChange(
      next === Mode.UNSPECIFIED
        ? undefined
        : create(ProviderUserConfigurationSchema, {
            mode: next,
            sourcePath: value?.sourcePath ?? inherited?.sourcePath ?? "",
            instructions: next !== Mode.ISOLATED,
            skills: next !== Mode.ISOLATED,
            hooks: false,
          }),
    );
  }

  return (
    <>
      <SettingChoice
        title="User configuration"
        value={mode}
        options={options}
        onChange={choose}
        description={options.find((item) => item.value === mode)?.description}
      />
      {value && (mode === Mode.LOCAL || mode === Mode.SHARED) && (
        <>
          <Field
            label="Configuration source"
            placeholder="Worker’s Claude configuration directory"
            value={value.sourcePath}
            onChangeText={(sourcePath) => onChange({ ...value, sourcePath })}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <SettingToggle
            title="Global instructions"
            value={value.instructions}
            onChange={(instructions) => onChange({ ...value, instructions })}
          />
          <SettingToggle
            title="Personal skills"
            value={value.skills}
            onChange={(skills) => onChange({ ...value, skills })}
          />
          <SettingToggle
            title="Hooks"
            description="Run commands from your local Claude settings."
            value={value.hooks}
            onChange={(hooks) => onChange({ ...value, hooks })}
          />
        </>
      )}
    </>
  );
}
