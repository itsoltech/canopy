import type { ui } from "@canopy/contracts";
import { ResetSetting } from "./ResetSetting";
import { SettingChoice, SettingToggle, SettingsGroup } from "./SettingsGroup";

export function PullRequestSettings({
  value,
  inherited,
  disabled,
  onChange,
}: {
  value: ui.ThreadDefaults;
  inherited?: ui.ThreadDefaults;
  disabled: boolean;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void;
}) {
  return (
    <SettingsGroup title="Pull requests">
      <PullRequestToggle
        title="Auto-archive after merge"
        resetLabel="Reset auto-archive after merge"
        description={
          inherited
            ? "Archive once all linked pull requests merge and a thread finishes working, unless the thread overrides it."
            : "Archive once all linked pull requests merge and a thread finishes working, unless a project or thread overrides it."
        }
        value={value.autoArchiveOnMerge}
        fallback={false}
        inherited={inherited && (inherited.autoArchiveOnMerge ?? false)}
        disabled={disabled}
        onChange={(autoArchiveOnMerge) => onChange({ autoArchiveOnMerge })}
      />
      <PullRequestToggle
        title="Notify agent about pull requests"
        resetLabel="Reset pull request notifications to default"
        description="Send merge conflicts and final check results to the agent in the linked thread."
        value={value.notifyOnLinkedPullRequests}
        fallback={true}
        inherited={inherited && (inherited.notifyOnLinkedPullRequests ?? true)}
        disabled={disabled}
        onChange={(notifyOnLinkedPullRequests) => onChange({ notifyOnLinkedPullRequests })}
      />
    </SettingsGroup>
  );
}

function PullRequestToggle({
  title,
  resetLabel,
  description,
  value,
  fallback,
  inherited,
  disabled,
  onChange,
}: {
  title: string;
  resetLabel: string;
  description: string;
  value: boolean | undefined;
  fallback: boolean;
  inherited: boolean | undefined;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  const accessory = (
    <ResetSetting
      label={resetLabel}
      changed={value !== undefined && (inherited !== undefined || value !== fallback)}
      disabled={disabled}
      onReset={() => onChange(undefined)}
    />
  );

  return inherited !== undefined ? (
    <SettingChoice
      title={title}
      description={description}
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
      description={description}
      value={value ?? fallback}
      accessory={accessory}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
