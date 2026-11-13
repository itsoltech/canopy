import { themeVariables, type ThemeMode, type ThemeName } from "@canopy/ui/themes";
import type { VisualTheme } from "./theme-tokens.ts";

/** The kit's tokens for a Canopy theme. Values are trusted literals from @canopy/ui. */
export function visualTheme(name: ThemeName, mode: ThemeMode, scale = 1): VisualTheme {
  const vars = themeVariables(name, mode);
  const palette: Readonly<Record<string, string>> = vars;
  const dark = mode === "dark";
  const tone = (hue: "sky" | "emerald" | "amber" | "rose") => palette[`${hue}-${dark ? 400 : 700}`] ?? vars.accent;

  return {
    mode,
    scale,
    colors: {
      canvas: vars.canvas,
      surface: vars.surface,
      panel: vars.panel,
      hover: vars.hover,
      ink: vars.ink,
      muted: vars.muted,
      border: vars.border,
      accent: vars.accent,
      action: vars.action,
      "action-hover": vars["action-hover"],
      "on-accent": vars["on-accent"],
      info: tone("sky"),
      success: tone("emerald"),
      warning: tone("amber"),
      danger: tone("rose"),
    },
  };
}
