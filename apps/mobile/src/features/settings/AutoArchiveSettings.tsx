import { ResetSetting } from "./ResetSetting";
import { SettingChoice, SettingToggle, SettingsGroup } from "./SettingsGroup";

export function AutoArchiveSettings({
  value,
  inherited,
  disabled,
  onChange,
}: {
  value: boolean | undefined;
  inherited?: boolean;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  const project = inherited !== undefined;
  const title = "Auto-archive after merge";

  const accessory = (
    <ResetSetting
      label="Reset auto-archive after merge"
      changed={project ? value !== undefined : !!value}
      disabled={disabled}
      onReset={() => onChange(undefined)}
    />
  );

  return (
    <SettingsGroup
      title="Pull requests"
      description="Archive after all linked pull requests merge and the thread finishes working."
    >
      {project ? (
        <SettingChoice
          title={title}
          description="Applies to existing and new threads in this project, unless a thread overrides it."
          value={value === undefined ? "inherit" : value ? "on" : "off"}
          options={[
            { value: "inherit", label: `Use my default (${inherited ? "on" : "off"})` },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          accessory={accessory}
          disabled={disabled}
          onChange={(choice) => onChange(choice === "inherit" ? undefined : choice === "on")}
        />
      ) : (
        <SettingToggle
          title={title}
          description="Applies to existing and new threads, unless a project or thread overrides it."
          value={value ?? false}
          accessory={accessory}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </SettingsGroup>
  );
}
