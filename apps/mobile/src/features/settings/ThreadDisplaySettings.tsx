import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { SettingsGroup } from "./SettingsGroup";

export function ThreadDisplaySettings() {
  return (
    <SettingsGroup title="Thread details" description="This device">
      <DeviceChoiceRow
        preference="showFinishedSubagents"
        title="Keep finished subagents in the list"
        description="When off, completed, failed and interrupted subagents stay in a separate expandable group."
        options={[
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ]}
      />
    </SettingsGroup>
  );
}
