import { Text, View } from "react-native";
import { useDevicePreferences } from "../../state/preferences";
import { deviceDefaults, type DeviceValues } from "../../storage/preferences";
import { IconButton, Segmented } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

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
          {/* The reset button keeps its row height, so showing it moves nothing. */}
          <View style={[styles.row, { minHeight: 32 }]}>
            <Text style={[styles.label, { flex: 1, color: c.text }]}>{choice.title}</Text>
            {preferences.values[choice.preference] !== deviceDefaults[choice.preference] && (
              <ResetButton
                label={`Reset ${choice.title} to default`}
                onPress={() => preferences.set(choice.preference, deviceDefaults[choice.preference])}
              />
            )}
          </View>
          <Text style={[styles.meta, { color: c.muted }]}>{choice.description}</Text>
          <Segmented<DeviceValues[typeof choice.preference]>
            value={preferences.values[choice.preference]}
            options={choice.options}
            onChange={(value) => preferences.set(choice.preference, value)}
          />
        </View>
      ))}
    </View>
  );
}

function ResetButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <IconButton icon="arrow-path" size="sm" label={label} onPress={onPress} />;
}
