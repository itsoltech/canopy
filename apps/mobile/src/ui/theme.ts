import { Platform, StyleSheet } from "react-native";
import { contextType, palette, typography } from "@canopy/ui";
import { themes, themeVariables, type ThemeName } from "@canopy/ui/themes";
import { useAppearance } from "../state/appearance";
import { themeOf } from "../features/settings/appearance";
import { useDevicePreferences } from "../features/settings/device-preferences";

export function colorsFor(dark: boolean, theme: ThemeName = "birch") {
  const v = themeVariables(theme, dark ? "dark" : "light");

  return {
    dark,
    background: v.canvas,
    surface: v.surface,
    overlay: v.panel,
    scrim: dark ? "#000000a6" : "#09090b66",
    sidebar: v.panel,
    inset: v.hover,
    text: v.ink,
    body: v.ink,
    muted: v.muted,
    faint: v.muted,
    line: v.border,
    accent: v.accent,
    action: v.action,
    onAccent: v["on-accent"],
    onControl: v["on-control"],
    softAccent: `${v.accent}1a`,
    warning: dark ? palette.amber[400] : palette.amber[700],
    danger: dark ? palette.rose[400] : palette.rose[700],
    sky: dark ? palette.sky[400] : palette.sky[700],
    success: dark ? palette.emerald[400] : palette.emerald[700],
    userBubble: v.hover,
    botUserBubble: v.ink,
    botUserText: v.canvas,
  };
}

export type Colors = ReturnType<typeof colorsFor>;

export function useColors() {
  const { dark, appearance } = useAppearance();
  const { values } = useDevicePreferences();
  const theme = themeOf(appearance, dark ? "dark" : "light");
  const colors = colorsFor(dark, theme);
  const neutral = themes[theme][dark ? "dark" : "light"];

  if (values.contrast === "standard") return colors;

  return {
    ...colors,
    muted: values.contrast === "maximum" ? colors.text : dark ? neutral[3] : neutral[8],
    line: dark ? neutral[5] : neutral[7],
  };
}

export function useTypography() {
  const { values } = useDevicePreferences();
  const scale = Number(values.interfaceSize) / 14;

  const family =
    values.interfaceFont === "serif"
      ? Platform.OS === "ios"
        ? "Georgia"
        : "serif"
      : values.interfaceFont === "system"
        ? Platform.OS === "ios"
          ? "System"
          : "sans-serif"
        : font.regular;

  const mono = Platform.OS === "ios" ? (values.monoFont === "consolas" ? "Courier" : "Menlo") : "monospace";

  return {
    body: {
      ...styles.body,
      fontFamily: family,
      fontSize: typography.body.fontSize * scale,
      lineHeight: typography.body.lineHeight * scale,
    },
    chrome: {
      ...styles.chrome,
      fontFamily: family,
      fontSize: contextType.chrome.fontSize * scale,
      lineHeight: contextType.chrome.lineHeight * scale,
    },
    meta: {
      ...styles.workMeta,
      fontFamily: family,
      fontSize: contextType.workSmall.fontSize * scale,
      lineHeight: contextType.workSmall.lineHeight * scale,
    },
    mono: { fontFamily: mono, fontSize: Number(values.monoSize), lineHeight: Number(values.monoSize) + 7 },
  };
}

export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
};

export const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: {
    width: "100%",
    maxWidth: 768,
    alignSelf: "center",
    padding: 16,
    gap: 16,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { ...typography.title, fontFamily: font.semibold },
  heading: { ...typography.heading, fontFamily: font.semibold },
  body: { ...typography.body, fontFamily: font.regular },
  label: { ...typography.body, fontFamily: font.medium },
  meta: { ...typography.small, fontFamily: font.regular },
  caption: { ...typography.caption, fontFamily: font.regular },
  overlay: { ...contextType.overlay, fontFamily: font.regular },
  overlayMeta: { ...contextType.overlaySmall, fontFamily: font.regular },
  overlayHeading: { ...contextType.overlaySmall, fontFamily: font.medium },
  chrome: { ...contextType.chrome, fontFamily: font.regular },
  chromeMeta: { ...contextType.chromeSmall, fontFamily: font.regular },
  work: { ...contextType.work, fontFamily: font.regular },
  workMeta: { ...contextType.workSmall, fontFamily: font.regular },
  context: { ...contextType.context, fontFamily: font.regular },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 44,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
});
