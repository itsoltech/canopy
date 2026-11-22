import { ui } from "@canopy/contracts";
import type { DeviceAppearance } from "@canopy/domain";
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

export function themeOf(appearance: DeviceAppearance, mode: ThemeMode): ThemeName {
  const value = mode === "light" ? appearance.lightTheme : appearance.darkTheme;

  return themeNames.find((name) => colorThemes[name] === value) ?? "birch";
}
