import { ui } from "@canopy/contracts";
import { themeNames, type ThemeMode, type ThemeName } from "@canopy/ui/themes";

export const colorThemes: Record<ThemeName, ui.ColorTheme> = {
  birch: ui.ColorTheme.BIRCH,
  fern: ui.ColorTheme.FERN,
  lagoon: ui.ColorTheme.LAGOON,
  cedar: ui.ColorTheme.CEDAR,
  heather: ui.ColorTheme.HEATHER,
  blossom: ui.ColorTheme.BLOSSOM,
  ash: ui.ColorTheme.ASH,
};

/** Unspecified variants inherit the account's original accent, exactly as on the web. */
export function themeOf(appearance: ui.AppearanceSettings | undefined, mode: ThemeMode): ThemeName {
  const value = appearance?.[mode === "light" ? "lightTheme" : "darkTheme"];

  return themeNames.find((name) => colorThemes[name] === value) ?? themeNames[(appearance?.accent || 1) - 1] ?? "birch";
}
