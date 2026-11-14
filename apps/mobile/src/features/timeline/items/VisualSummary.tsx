import { Text, View } from "react-native";
import type { Visual } from "@canopy/contracts";
import { Icon } from "../../../ui/Icon";
import { font, styles, useColors, useTypography } from "../../../ui/theme";

/**
 * An interactive visual (docs/agent-visuals.md) on a build without the WebView module: the title, its version and
 * where to open it. The spec is never read or run here.
 */
export function VisualSummary({ visual }: { visual: Visual }) {
  const c = useColors();
  const type = useTypography();

  return (
    <View
      accessible
      accessibilityLabel={`Visual: ${visual.title}, version ${visual.version}. ${visual.description} Open this visual on web or desktop.`}
      style={{ gap: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.ring, backgroundColor: c.surface }}
    >
      <View style={styles.row}>
        <Icon name="square-2-stack" color={c.icon} />
        <Text numberOfLines={2} style={[type.body, { flex: 1, fontFamily: font.medium, color: c.text }]}>
          {visual.title}
        </Text>
        <Text style={[type.small, { color: c.muted, fontVariant: ["tabular-nums"] }]}>Version {visual.version}</Text>
      </View>
      <Text style={[type.small, { paddingLeft: 24, color: c.muted }]}>Open this visual on web or desktop.</Text>
    </View>
  );
}
