import type { ThemeMode } from "@canopy/ui/themes";

/** Semantic tokens a host may pass into a visual. Nothing else reaches the frame's styles. */
export const VISUAL_TOKEN_NAMES = [
  "canvas",
  "surface",
  "panel",
  "hover",
  "ink",
  "muted",
  "border",
  "accent",
  "action",
  "action-hover",
  "on-accent",
  "info",
  "success",
  "warning",
  "danger",
] as const;

export type VisualTokenName = (typeof VISUAL_TOKEN_NAMES)[number];

export interface VisualTheme {
  readonly mode: ThemeMode;
  readonly colors: { readonly [K in VisualTokenName]: string };
  /** Appearance → Interface size, as a factor of 16 px. */
  readonly scale: number;
}

const HEX = "#[0-9a-fA-F]{3,8}";
const COLOR = new RegExp(`^(?:${HEX}|color-mix\\(in oklab, ${HEX} \\d{1,3}%, ${HEX}\\))$`);

export const isVisualColor = (value: string): boolean => COLOR.test(value);

export function visualScaleAllowed(scale: number): boolean {
  return Number.isFinite(scale) && scale >= 0.75 && scale <= 1.5;
}

/** A theme only when every token is a plain colour and the scale is in range; hosts and the kit both check it. */
export function validVisualTheme(theme: VisualTheme): boolean {
  return (
    (theme.mode === "light" || theme.mode === "dark") &&
    visualScaleAllowed(theme.scale) &&
    VISUAL_TOKEN_NAMES.every((name) => isVisualColor(theme.colors[name]))
  );
}
