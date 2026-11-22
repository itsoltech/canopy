import { contextType, palette } from "@canopy/ui";
import { channel } from "expo-updates";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { usePaneInsets } from "../../ui/ScreenFrame";
import { styles, useColors, useTypography } from "../../ui/theme";

const release =
  channel === "nightly"
    ? { label: "Nightly", tone: palette.violet, neutral: false }
    : channel === "beta"
      ? { label: "Beta", tone: palette.amber, neutral: false }
      : !channel
        ? { label: "Dev", tone: palette.zinc, neutral: true }
        : undefined;

export function SidebarBrand() {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={[styles.row, brand.row]}>
      <Image source={require("../../../../web/static/canopy-logo.png")} style={brand.logo} />
      <View style={brand.row}>
        <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
          Canopy
        </Text>
        {release && (
          <Text
            numberOfLines={1}
            style={[
              contextType.context,
              { color: release.neutral ? c.muted : release.tone[c.dark ? 400 : 800], fontFamily: type.mono.fontFamily },
            ]}
          >
            {release.label}
          </Text>
        )}
      </View>
    </View>
  );
}

const artDepth = 88;
const ringWidth = 288;
const ringAngle = -24;

const rings = [
  { rx: 80, ry: 40 },
  { rx: 104, ry: 52 },
  { rx: 128, ry: 64 },
];

function ringOutline(rx: number, ry: number, cy: number) {
  const cx = ringWidth - 32 - rx;
  const radians = (ringAngle * Math.PI) / 180;
  const dx = rx * Math.cos(radians);
  const dy = rx * Math.sin(radians);
  const arc = `A ${rx} ${ry} ${ringAngle} 0 1`;

  return `M ${cx + dx} ${cy + dy} ${arc} ${cx - dx} ${cy - dy} ${arc} ${cx + dx} ${cy + dy} Z`;
}

/** The web sidebar's channel tint and tree-ring contours, extending into the top safe area. */
export function SidebarReleaseArt() {
  const { top, right } = usePaneInsets();
  const { dark } = useColors();

  if (!release) return null;

  const { tone, neutral } = release;
  const height = top + artDepth;
  const ringY = top + 24;
  const ringColor = tone[dark ? 400 : 600];
  const ringOpacity = neutral ? 0.1 : 0.15;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[brand.art, { height }]}
    >
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="tint" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={tone[500]} stopOpacity={neutral ? 0.08 : 0.1} />
            <Stop offset="50%" stopColor={tone[500]} stopOpacity={neutral ? 0.03 : 0.04} />
            <Stop offset="100%" stopColor={tone[500]} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={height} fill="url(#tint)" />
      </Svg>
      <Svg width={ringWidth} height={height} style={[brand.rings, { right }]}>
        <Defs>
          <LinearGradient id="ring-fade" x1={0} y1={top} x2={0} y2={height} gradientUnits="userSpaceOnUse">
            <Stop offset="0%" stopColor={ringColor} stopOpacity={0} />
            <Stop offset="10%" stopColor={ringColor} stopOpacity={ringOpacity} />
            <Stop offset="40%" stopColor={ringColor} stopOpacity={ringOpacity} />
            <Stop offset="100%" stopColor={ringColor} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {rings.map(({ rx, ry }) => (
          <Path key={rx} d={ringOutline(rx, ry, ringY)} stroke="url(#ring-fade)" fill="none" />
        ))}
      </Svg>
    </View>
  );
}

const brand = StyleSheet.create({
  row: { flexShrink: 1 },
  logo: { width: 24, height: 24, borderRadius: 6 },
  art: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
  rings: { position: "absolute", top: 0 },
});
