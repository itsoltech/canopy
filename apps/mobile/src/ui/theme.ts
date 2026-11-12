import { StyleSheet } from "react-native";
import { contextType, palette, typography } from "@canopy/ui";
import { workingColors } from "@canopy/ui/thread-row";
import { neutralSteps, themes, themeVariables, type ThemeName } from "@canopy/ui/themes";
import { useAppearance } from "../state/appearance";
import { themeOf } from "../features/settings/appearance";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { mobileFontFamily } from "../features/settings/mobile-fonts";

export function colorsFor(dark: boolean, theme: ThemeName = "birch") {
  const v = themeVariables(theme, dark ? "dark" : "light");
  const neutral = themes[theme][dark ? "dark" : "light"];
  const hue = themes[theme].accent;
  const zinc = (step: (typeof neutralSteps)[number]) => neutral[neutralSteps.indexOf(step)] ?? v.muted;

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
    /** Web shimmer's zinc-300 / zinc-100 highlight. */
    shimmerHighlight: dark ? zinc(100) : zinc(300),
    /** zinc-400 / zinc-500: chevrons and quiet icons. */
    faint: dark ? zinc(500) : zinc(400),
    /** zinc-700 / zinc-300: secondary text a step under the ink. */
    soft: dark ? zinc(300) : zinc(700),
    /** zinc-800 / zinc-200: titles inside work rows. */
    strong: dark ? zinc(200) : zinc(800),
    /** Hairlines and rails: zinc-950/5, white/10. */
    rule: dark ? "#ffffff1a" : "#09090b0d",
    /** Recessed wells (code, prompts, forks): zinc-950/2.5, white/5. */
    well: dark ? "#ffffff0d" : "#09090b06",
    line: v.border,
    /** Control and card rings: zinc-950/10, white/10. */
    ring: dark ? "#ffffff1a" : `${zinc(950)}1a`,
    /** Recessed tracks (segmented controls): zinc-950/5, white/5. */
    recess: dark ? "#ffffff0d" : `${zinc(950)}0d`,
    /** Pressed rows and ghost controls: zinc-950/5, white/10. */
    pressed: dark ? "#ffffff1a" : `${zinc(950)}0d`,
    /** Icons at rest (web: icon-muted) and pressed (icon-emphasis). */
    icon: dark ? zinc(400) : zinc(500),
    iconStrong: dark ? zinc(300) : zinc(700),
    /** Secondary buttons: white, white/5; pressed zinc-50, white/10. */
    control: dark ? "#ffffff0d" : "#ffffff",
    controlPressed: dark ? "#ffffff1a" : zinc(50),
    /** Switch track: zinc-200, white/5; checked brand-600, brand-500. */
    track: dark ? "#ffffff0d" : zinc(200),
    /** Actions on dark toasts: brand-400. */
    brandOnInk: hue === "neutral" ? "#ffffff" : palette[hue][400],
    brand: hue === "neutral" ? v.action : palette[hue][dark ? 500 : 600],
    accent: v.accent,
    action: v.action,
    actionPressed: v["action-hover"],
    onAccent: v["on-accent"],
    onControl: v["on-control"],
    softAccent: `${v.accent}1a`,
    warning: dark ? palette.amber[400] : palette.amber[700],
    danger: dark ? palette.rose[400] : palette.rose[700],
    dangerPressed: dark ? `${palette.rose[500]}1a` : palette.rose[50],
    sky: dark ? palette.sky[400] : palette.sky[700],
    working: workingColors[dark ? "dark" : "light"],
    agent: dark ? palette.violet[400] : palette.violet[700],
    interrupted: dark ? palette.orange[400] : palette.orange[700],
    projectNeutral: { fill: zinc(500), text: dark ? zinc(300) : zinc(700) },
    success: dark ? palette.emerald[400] : palette.emerald[700],
    userBubble: v.hover,
    /** A bot's chat bubble: zinc-100, zinc-800/80. */
    botBubble: dark ? `${zinc(800)}cc` : zinc(100),
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

  const family = mobileFontFamily(values.interfaceFont, "interface");
  const mono = mobileFontFamily(values.monoFont, "mono");

  return {
    body: {
      ...styles.body,
      fontFamily: family,
      fontSize: typography.body.fontSize * scale,
      lineHeight: typography.body.lineHeight * scale,
    },
    /** Secondary text a step under the body: 14 (web: text-sm on phones). */
    small: {
      ...styles.meta,
      fontFamily: family,
      fontSize: typography.small.fontSize * scale,
      lineHeight: typography.small.lineHeight * scale,
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
  regularItalic: "Inter_400Regular_Italic",
  mediumItalic: "Inter_500Medium_Italic",
  semiboldItalic: "Inter_600SemiBold_Italic",
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
    minHeight: 40,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
});
