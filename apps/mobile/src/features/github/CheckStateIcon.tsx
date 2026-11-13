import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import type { PullRequestLook } from "@canopy/domain/github-pr";
import { Icon } from "../../ui/Icon";
import { WorkingSpinner } from "../../ui/WorkingSpinner";
import { useMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { toneColor } from "./presentation";

/** One fixed slot for CI and timeline states, using the sidebar's working ring. */
export function CheckStateIcon({
  look,
  label = look.label,
  showStatus = false,
}: {
  look: PullRequestLook;
  label?: string;
  showStatus?: boolean;
}) {
  const c = useColors();
  const { iconSwap } = useMotion();

  const mark = (
    <Animated.View
      key={`${look.spinning}:${look.icon}:${look.tone}`}
      entering={iconSwap.entering}
      style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}
    >
      {look.spinning ? (
        <WorkingSpinner color={c.working.indicator} />
      ) : (
        <Icon name={look.icon} color={toneColor(c, look.tone)} />
      )}
    </Animated.View>
  );

  if (showStatus)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Show status"
        hitSlop={12}
        onPress={() => toast(label)}
        onLongPress={() => toast(label)}
        style={{ width: 16, height: 16, flexShrink: 0 }}
      >
        {mark}
      </Pressable>
    );

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: 16, height: 16, flexShrink: 0 }}
    >
      {mark}
    </View>
  );
}
