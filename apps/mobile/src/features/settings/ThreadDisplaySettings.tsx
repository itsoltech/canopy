import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { SettingsGroup } from "./SettingsGroup";

export function ThreadDisplaySettings() {
  return (
    <SettingsGroup title="Thread details" description="This device">
      <DeviceChoiceRow
        preference="showFinishedSubagents"
        title="Show finished subagents"
        description="Include completed, failed and interrupted subagents in thread details."
        options={[
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ]}
      />
    </SettingsGroup>
  );
}
