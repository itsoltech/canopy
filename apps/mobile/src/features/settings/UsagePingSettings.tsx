import { useUsagePing } from "../../state/usage-ping";
import { Notice } from "../../ui/components";
import { SettingToggle, SettingsGroup } from "./SettingsGroup";

export function UsagePingSettings({ disabled = false }: { disabled?: boolean }) {
  const { enabled, saving, error, change } = useUsagePing();

  return (
    <SettingsGroup title="Privacy" description="This device">
      <SettingToggle
        title="Send daily usage ping"
        description="Canopy sends its version, operating system, CPU architecture, language and screen size to its analytics server to estimate daily use."
        value={enabled ?? false}
        disabled={disabled || saving || enabled === undefined}
        onChange={(value) => void change(value)}
      />
      {error ? <Notice error>{error}</Notice> : null}
    </SettingsGroup>
  );
}
