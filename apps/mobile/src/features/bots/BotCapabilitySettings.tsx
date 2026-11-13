import type { bots } from "@canopy/contracts";
import { SettingToggle } from "../settings/SettingsGroup";

export function BotCapabilitySettings({
  config,
  onChange,
  disabled,
}: {
  config: bots.BotConfiguration;
  onChange: (config: bots.BotConfiguration) => void;
  disabled: boolean;
}) {
  return (
    <>
      <SettingToggle
        title="Web access"
        description="Search the web and read public pages."
        value={config.webAccess !== false}
        onChange={(webAccess) => onChange({ ...config, webAccess })}
        disabled={disabled}
      />
      <SettingToggle
        title="Files"
        description="Create, download, and send files in this conversation."
        value={config.files !== false}
        onChange={(files) => onChange({ ...config, files })}
        disabled={disabled}
      />
    </>
  );
}
