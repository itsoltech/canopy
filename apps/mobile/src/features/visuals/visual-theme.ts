import { visualTheme, type VisualTheme } from "@canopy/domain/visuals";
import { useMemo } from "react";
import { useAppearance } from "../../state/appearance";
import { themeOf } from "../settings/appearance";
import { useDevicePreferences } from "../settings/device-preferences";

/** The visual's tokens for the app's appearance: theme, light/dark and Interface size (14 px = 1). */
export function useVisualTheme(): VisualTheme {
  const { dark, appearance } = useAppearance();
  const { values } = useDevicePreferences();
  const mode = dark ? "dark" : "light";
  const name = themeOf(appearance, mode);
  const scale = Math.min(1.5, Math.max(0.75, Number(values.interfaceSize) / 14 || 1));

  return useMemo(() => visualTheme(name, mode, scale), [name, mode, scale]);
}
