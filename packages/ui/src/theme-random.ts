import { neutralSteps, themeStatusTones, toneSteps, type ThemeColors } from "./theme-builder.ts";
import { hexFromOklch } from "./theme-color-math.ts";
import type { ThemeMode } from "./themes.ts";

const harmonies = [
  [30, -30], // Analogous
  [150, -150], // Split complementary
  [120, -120], // Triadic
] as const;

const paper = [0.993, 0.975, 0.952, 0.906, 0.82, 0.66, 0.5, 0.44, 0.38, 0.3, 0.25, 0.21, 0.17];
const night = [0.965, 0.937, 0.9, 0.855, 0.8, 0.745, 0.675, 0.565, 0.455, 0.355, 0.3, 0.255, 0.21];
const ramp = [0.972, 0.934, 0.89, 0.837, 0.765, 0.673, 0.58, 0.49, 0.404, 0.345, 0.24];

const statusHues = {
  emerald: 158,
  amber: 84,
  rose: 16,
  sky: 235,
  orange: 50,
  violet: 293,
};

function toneRamp(tone: "brand" | (typeof themeStatusTones)[number], hue: number, mode: ThemeMode): ThemeColors {
  return Object.fromEntries(
    toneSteps.map((step, index) => {
      let level = ramp[index]!;

      if (mode === "light" && step === 600) level = 0.515;

      if (mode === "dark" && step === 400) level = 0.82;
      const chroma = Math.min(0.16, 0.73 * (1 - level), 0.42 * level);

      return [`${tone}-${step}`, hexFromOklch(level, chroma, hue)];
    }),
  );
}

function colorsForMode(mode: ThemeMode, base: number, accent: number, secondary: number): ThemeColors {
  const dark = mode === "dark";
  const levels = dark ? night : paper;

  const neutral = (index: number) => {
    const level = levels[index]!;
    const chroma = dark ? Math.min(0.04, 0.45 * (1 - level)) : Math.min(0.027, 0.55 * (1 - level));

    return hexFromOklch(level, chroma, index === 10 || index === 2 ? secondary : base);
  };

  const neutralRamp = Object.fromEntries(neutralSteps.map((step, index) => [`zinc-${step}`, neutral(index)]));

  const statuses = Object.assign(
    {},
    ...themeStatusTones.map((tone) => {
      const hue = statusHues[tone];
      const diff = ((secondary - hue + 540) % 360) - 180;

      return toneRamp(tone, hue + Math.min(12, Math.max(-12, diff * 0.2)), mode);
    }),
  );

  return {
    ...neutralRamp,
    ...toneRamp("brand", accent, mode),
    ...statuses,
    canvas: neutral(dark ? 12 : 0),
    surface: neutral(dark ? 11 : 0),
    panel: neutral(dark ? 10 : 1),
    hover: neutral(dark ? 9 : 2),
    ink: neutral(dark ? 0 : 11),
    muted: neutral(dark ? 4 : 6),
    border: neutral(dark ? 8 : 3),
    accent: hexFromOklch(dark ? 0.82 : 0.48, dark ? 0.1 : 0.16, accent),
    action: hexFromOklch(0.475, 0.145, accent),
    "action-hover": hexFromOklch(0.4, 0.135, accent),
    "on-accent": "#ffffff",
    "on-control": dark ? neutral(12) : "#ffffff",
  };
}

export function randomizeThemeColors(): Record<ThemeMode, ThemeColors> {
  const base = Math.random() * 360;
  const [accent, secondary] = harmonies[Math.floor(Math.random() * harmonies.length)]!;

  return {
    light: colorsForMode("light", base, base + accent, base + secondary),
    dark: colorsForMode("dark", base, base + accent, base + secondary),
  };
}
