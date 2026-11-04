import { StyleSheet } from "react-native";
import { accents, palette, typography, type AccentName } from "@canopy/ui";
import { useAppearance } from "../state/appearance";

export function colorsFor(dark: boolean, accent: AccentName = "default") {
  const z = palette.zinc;
  const brand = palette[accents.find((a) => a.name === accent)?.palette ?? "blue"];

  return {
    dark,
    background: dark ? "#000000" : "#ffffff",
    surface: dark ? z[950] : "#ffffff",
    sidebar: dark ? z[950] : z[50],
    inset: dark ? "#ffffff0d" : "#09090b0d",
    text: dark ? "#ffffff" : z[950],
    body: dark ? z[200] : z[800],
    muted: dark ? z[400] : z[500],
    faint: dark ? z[600] : z[400],
    line: dark ? "#ffffff1a" : "#09090b1a",
    accent: brand[600],
    onAccent: "#ffffff",
    softAccent: dark ? `${brand[400]}1a` : brand[50],
    warning: dark ? palette.amber[400] : palette.amber[700],
    danger: dark ? palette.rose[400] : palette.rose[700],
    sky: dark ? palette.sky[400] : palette.sky[700],
    success: dark ? palette.emerald[400] : palette.emerald[700],
    userBubble: dark ? "#ffffff1a" : z[100],
    botUserBubble: dark ? z[100] : z[900],
    botUserText: dark ? z[950] : "#ffffff",
  };
}

export type Colors = ReturnType<typeof colorsFor>;

export function useColors() {
  const { dark, accent } = useAppearance();

  return colorsFor(dark, accent);
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
