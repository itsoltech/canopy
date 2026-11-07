import { View, type StyleProp, type ViewStyle } from "react-native";
import { useColors } from "./theme";
import { useTone } from "./tone";

/** Web: ProgressBar. A bounded percentage with its accessible label; no second counter. */
export function ProgressBar({
  done,
  total,
  label,
  style,
}: {
  done: bigint;
  total: bigint;
  label: string;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const tone = useTone("sky");
  const percent = total > 0n ? Math.max(0, Math.min(100, (Number(done) / Number(total)) * 100)) : 0;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      style={[{ height: 6, borderRadius: 3, backgroundColor: c.well, overflow: "hidden" }, style]}
    >
      <View style={{ width: `${percent}%`, height: "100%", borderRadius: 3, backgroundColor: tone.dot }} />
    </View>
  );
}
