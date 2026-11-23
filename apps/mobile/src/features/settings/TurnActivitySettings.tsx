import { useDevicePreferences } from "../../state/preferences";
import { deviceDefaults, type DeviceValues } from "../../storage/preferences";
import { SettingChoice, SettingsGroup } from "./SettingsGroup";
import { ResetSetting } from "./ResetSetting";

const choices = [
  {
    preference: "workWhileWorking",
    title: "While working",
    description: "Show tool calls, reasoning summaries and progress messages during a turn.",
    options: [
      { value: "expanded", label: "Expanded" },
      { value: "collapsed", label: "Collapsed" },
    ],
  },
  {
    preference: "workToolCalls",
    title: "Tool calls",
    description: "Expand tool groups during a turn.",
    options: [
      { value: "collapsed", label: "Collapsed" },
      { value: "expanded", label: "Expanded" },
    ],
  },
  {
    preference: "workAfterTurn",
    title: "After the turn",
    description: "Collapse when the agent marks the final answer, or when the turn ends.",
    options: [
      { value: "collapse", label: "Collapse" },
      { value: "keep-open", label: "Keep open" },
    ],
  },
] as const;

/** The "Working for …" fold of each turn, per device as on the web (Settings → Threads → Turn activity). */
export function TurnActivitySettings() {
  const preferences = useDevicePreferences();

  return (
    <SettingsGroup title="Turn activity" description="This device">
      {choices.map((choice) => (
        <SettingChoice<DeviceValues[typeof choice.preference]>
          key={choice.preference}
          title={choice.title}
          description={choice.description}
          value={preferences.values[choice.preference]}
          options={[...choice.options]}
          onChange={(value) => preferences.set(choice.preference, value)}
          accessory={
            <ResetSetting
              label={`Reset ${choice.title} to default`}
              changed={preferences.values[choice.preference] !== deviceDefaults[choice.preference]}
              onReset={() => preferences.set(choice.preference, deviceDefaults[choice.preference])}
            />
          }
        />
      ))}
    </SettingsGroup>
  );
}
