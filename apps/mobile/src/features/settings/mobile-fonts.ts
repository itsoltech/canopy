import { Platform } from "react-native";
import { fontPresets, type FontKind } from "@canopy/ui/fonts";

const iosFonts = [
  { family: "System", label: "System (San Francisco)" },
  { family: "ui-serif", label: "New York" },
  { family: "Georgia" },
  { family: "Avenir Next" },
  { family: "Helvetica Neue" },
  { family: "Times New Roman" },
  { family: "Menlo", mono: true },
  { family: "Courier", mono: true },
];

const androidFonts = [
  { family: "sans-serif", label: "Roboto" },
  { family: "sans-serif-light", label: "Roboto Light" },
  { family: "sans-serif-medium", label: "Roboto Medium" },
  { family: "sans-serif-condensed", label: "Roboto Condensed" },
  { family: "serif", label: "Noto Serif" },
  { family: "monospace", label: "System monospace", mono: true },
];

export const mobileFontFamilies = Platform.OS === "ios" ? iosFonts : androidFonts;

export function mobileFontOptions(kind: FontKind) {
  return [
    ...fontPresets(kind).map((font) => ({
      value: font.value,
      label: font.label,
      fontFamily: mobileFontFamily(font.value, kind),
    })),
    ...mobileFontFamilies
      .filter((font) => kind !== "mono" || font.mono)
      .map((font) => ({
        value: `local:${font.family}`,
        label: font.label ?? font.family,
        fontFamily: font.family,
      })),
  ];
}

export function mobileFontFamily(value: string, kind: FontKind): string {
  const local = mobileFontFamilies.find((font) => value === `local:${font.family}`);

  if (local && (kind !== "mono" || local.mono)) return local.family;

  if (kind === "mono") return Platform.OS === "ios" ? (value === "consolas" ? "Courier" : "Menlo") : "monospace";

  if (value === "serif") return Platform.OS === "ios" ? "Georgia" : "serif";

  if (value === "system") return Platform.OS === "ios" ? "System" : "sans-serif";

  return "Inter_400Regular";
}
