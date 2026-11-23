import { contextType, palette } from "@canopy/ui";
import { sidebarIdentity } from "@canopy/ui/sidebar-art";
import { StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { AppIcon, mobileApp } from "../../ui/AppIcon";
import { styles, useColors, useTypography } from "../../ui/theme";

const identity = sidebarIdentity[mobileApp.channel];
const tone = palette[identity.tone];

export function SidebarBrand() {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={[styles.row, brand.title]}>
      <AppIcon size={32} />
      <View style={brand.title}>
        <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
          Canopy
        </Text>
        {mobileApp.channel !== "stable" && (
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

export function SidebarGradient({ topInset, offset = 0 }: { topInset: number; offset?: number }) {
  if (!identity.gradient) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        top: offset,
        left: 0,
        right: 0,
        height: topInset + 88,
        backgroundImage: identity.gradient,
      }}
    />
  );
}

export function SidebarWatermark() {
  const { dark } = useColors();

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <SvgXml xml={identity.art} color={identity.ink[dark ? "dark" : "light"]} width="100%" height="100%" />
    </View>
  );
}

const brand = StyleSheet.create({
  title: { flexShrink: 1 },
});
