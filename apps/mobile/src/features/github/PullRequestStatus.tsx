import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { pullRequestLook, type PullRequestLook } from "@canopy/domain/github-pr";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";
import { toneColor } from "./presentation";

export function PullRequestStatus({
  state,
  iconOnly = false,
  style,
}: {
  state: string;
  iconOnly?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return <PullRequestStatusLook look={pullRequestLook(state)} iconOnly={iconOnly} style={style} />;
}

export function PullRequestStatusLook({
  look,
  iconOnly = false,
  style,
}: {
  look: PullRequestLook;
  iconOnly?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const type = useTypography();
  const color = toneColor(c, look.tone);

  return (
    <View accessibilityLabel={look.label} style={[{ flexDirection: "row", alignItems: "center", gap: 6 }, style]}>
      <Icon name={look.icon} color={color} />
      {!iconOnly && <Text style={[type.meta, { color }]}>{look.label}</Text>}
    </View>
  );
}
