import { Text, View } from "react-native";
import { useDevicePreferences } from "../../state/preferences";
import { deviceDefaults, type DeviceValues } from "../../storage/preferences";
import { Segmented } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
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
  const c = useColors();
  const preferences = useDevicePreferences();

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 2 }}>
        <Text style={[styles.heading, { color: c.text }]}>Turn activity</Text>
        <Text style={[styles.meta, { color: c.muted }]}>This device</Text>
      </View>
      {choices.map((choice) => (
        <View key={choice.preference} style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.text }]}>{choice.title}</Text>
          <Text style={[styles.meta, { color: c.muted }]}>{choice.description}</Text>
          {/* Reset sits on the control's inner side with its space reserved, as on the web: nothing moves. */}
          <View style={[styles.row, { gap: 8 }]}>
            <ResetSetting
              label={`Reset ${choice.title} to default`}
              changed={preferences.values[choice.preference] !== deviceDefaults[choice.preference]}
              onReset={() => preferences.set(choice.preference, deviceDefaults[choice.preference])}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Segmented<DeviceValues[typeof choice.preference]>
                value={preferences.values[choice.preference]}
                options={choice.options}
                onChange={(value) => preferences.set(choice.preference, value)}
              />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
