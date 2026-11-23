import { contextType, palette } from "@canopy/ui";
import { sidebarIdentity } from "@canopy/ui/sidebar-art";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";
import { useContentInsets } from "../../ui/ScreenFrame";
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

/** A single scene stays at the pane edge, including during native overscroll. */
export function SidebarBackdrop({
  controlsHeight,
  brandHeight,
  collapsed,
}: {
  controlsHeight: number;
  brandHeight: number;
  collapsed: DerivedValue<number>;
}) {
  const { dark } = useColors();
  const insets = useContentInsets();

  const clip = useAnimatedStyle(() => ({
    height: insets.top + controlsHeight - collapsed.get(),
    opacity: 1 - collapsed.get() / brandHeight,
  }));

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[brand.backdrop, clip]}
    >
      {identity.gradient && <View style={{ height: insets.top + 88, backgroundImage: identity.gradient }} />}
      <View
        style={{
          position: "absolute",
          top: insets.top,
          left: insets.left,
          right: insets.right,
          height: controlsHeight,
        }}
      >
        <SvgXml xml={identity.art} color={identity.ink[dark ? "dark" : "light"]} width="100%" height="100%" />
      </View>
    </Animated.View>
  );
}

const brand = StyleSheet.create({
  title: { flexShrink: 1 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
});
