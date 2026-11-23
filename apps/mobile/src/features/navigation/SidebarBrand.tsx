import { contextType, palette } from "@canopy/ui";
import { sidebarIcon, sidebarIdentity } from "@canopy/ui/sidebar-art";
import { channel } from "expo-updates";
import { StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useContentInsets } from "../../ui/ScreenFrame";
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

export function SidebarWatermark() {
  const { dark } = useColors();
  const { bottom } = useContentInsets();

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[brand.watermark, { bottom }]}
    >
      <SvgXml xml={identity.art} color={identity.ink[dark ? "dark" : "light"]} width="100%" height="100%" />
    </View>
  );
}

const brand = StyleSheet.create({
  title: { flexShrink: 1 },
  watermark: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
});
