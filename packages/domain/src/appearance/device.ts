import { ui } from "@canopy/contracts";
import { Schema } from "effect";

export type DeviceAppearance = Pick<ui.AppearanceSettings, "colorScheme" | "lightTheme" | "darkTheme" | "chatWidth">;

const schemes = Schema.Literals([ui.ColorScheme.SYSTEM, ui.ColorScheme.LIGHT, ui.ColorScheme.DARK]);
const widths = Schema.Literals([ui.ChatWidth.COMFORTABLE, ui.ChatWidth.WIDE, ui.ChatWidth.FULL]);

const themes = Schema.Literals([
  ui.ColorTheme.BIRCH,
  ui.ColorTheme.FERN,
  ui.ColorTheme.LAGOON,
  ui.ColorTheme.CEDAR,
  ui.ColorTheme.HEATHER,
  ui.ColorTheme.BLOSSOM,
  ui.ColorTheme.ASH,
]);

const isScheme = Schema.is(schemes);
const isWidth = Schema.is(widths);
const isTheme = Schema.is(themes);

const decode = Schema.decodeUnknownSync(
  Schema.Struct({ colorScheme: schemes, chatWidth: widths, lightTheme: themes, darkTheme: themes }),
);

export const deviceAppearanceDefaults: DeviceAppearance = {
  colorScheme: ui.ColorScheme.SYSTEM,
  chatWidth: ui.ChatWidth.COMFORTABLE,
  lightTheme: ui.ColorTheme.BIRCH,
  darkTheme: ui.ColorTheme.BIRCH,
};

const accentThemes: Partial<Record<ui.AccentTheme, ui.ColorTheme>> = {
  [ui.AccentTheme.DEFAULT]: ui.ColorTheme.BIRCH,
  [ui.AccentTheme.GROVE]: ui.ColorTheme.FERN,
  [ui.AccentTheme.OCEAN]: ui.ColorTheme.LAGOON,
  [ui.AccentTheme.EMBER]: ui.ColorTheme.CEDAR,
  [ui.AccentTheme.IRIS]: ui.ColorTheme.HEATHER,
  [ui.AccentTheme.ROSE]: ui.ColorTheme.BLOSSOM,
};

/** Resolve the old account appearance once, including themes saved before separate palettes existed. */
export function legacyDeviceAppearance(appearance: ui.AppearanceSettings | undefined): DeviceAppearance {
  if (!appearance) return { ...deviceAppearanceDefaults };
  const { colorScheme, chatWidth, lightTheme, darkTheme, accent } = appearance;
  const fallback = accentThemes[accent] ?? ui.ColorTheme.BIRCH;

  return {
    colorScheme: isScheme(colorScheme) ? colorScheme : deviceAppearanceDefaults.colorScheme,
    chatWidth: isWidth(chatWidth) ? chatWidth : deviceAppearanceDefaults.chatWidth,
    lightTheme: isTheme(lightTheme) ? lightTheme : fallback,
    darkTheme: isTheme(darkTheme) ? darkTheme : fallback,
  };
}

export function parseDeviceAppearance(raw: string | null): DeviceAppearance | undefined {
  if (!raw) return undefined;

  try {
    return decode(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
