import { contextType, palette } from "@canopy/ui";
import { sidebarIcon, sidebarIdentity } from "@canopy/ui/sidebar-art";
import { channel } from "expo-updates";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop, SvgXml } from "react-native-svg";
import { usePaneInsets } from "../../ui/ScreenFrame";
import { styles, useColors, useTypography } from "../../ui/theme";

const release = channel === "nightly" || channel === "beta" ? channel : channel ? "stable" : "development";
const identity = sidebarIdentity[release];
const tone = palette[identity.tone];

export function SidebarBrand() {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={[styles.row, brand.title]}>
      <SvgXml
        xml={sidebarIcon}
        width={24}
        height={24}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <View style={brand.title}>
        <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
          Canopy
        </Text>
        {release !== "stable" && (
          <Text
            numberOfLines={1}
            style={[contextType.context, { color: tone[c.dark ? 400 : 800], fontFamily: type.mono.fontFamily }]}
          >
            {identity.label}
          </Text>
        )}
      </View>
    </View>
  );
}

const artHeight = 88;

/** The tint extends through the status bar, while the tree aligns with the pane's safe edge. */
export function SidebarReleaseArt() {
  const { top, right } = usePaneInsets();
  const { dark } = useColors();
  const height = top + artHeight;
  const development = release === "development";

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[brand.backdrop, { height }]}
    >
      {release !== "stable" && (
        <Svg width="100%" height={height}>
          <Defs>
            <LinearGradient id="tint" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor={tone[500]} stopOpacity={development ? 0.08 : 0.1} />
              <Stop offset="50%" stopColor={tone[500]} stopOpacity={development ? 0.03 : 0.04} />
              <Stop offset="100%" stopColor={tone[500]} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height={height} fill="url(#tint)" />
        </Svg>
      )}
      {/* Narrow panes crop the scene's left margin so the tree stays beside the compose button. */}
      <View style={[brand.artwork, { top: top + 4, right: right + 3 }]}>
        <SvgXml xml={identity.art} color={identity.ink[dark ? "dark" : "light"]} width={160} height={artHeight} />
      </View>
    </View>
  );
}

const brand = StyleSheet.create({
  title: { flexShrink: 1 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
  artwork: { position: "absolute", width: "50%", alignItems: "flex-end", overflow: "hidden" },
});
