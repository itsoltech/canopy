import { isThemeName, type ThemeMode, type ThemeName } from "@canopy/ui/themes";
import { packThemeColors, unpackThemeColors } from "@canopy/ui/theme-builder";
import { Schema } from "effect";
import { colorThemes, themeOf } from "./appearance.ts";
import { isAccent, themeOptionsOf, type ThemeOptions, type WebAppearance } from "./theme-customization.ts";

/** The palette part of the theme options: what a custom theme stores for both color schemes. */
export type ThemeColorOptions = Pick<
  ThemeOptions,
  "lightTheme" | "darkTheme" | "lightAccent" | "darkAccent" | "lightColors" | "darkColors"
>;

export interface CustomTheme extends ThemeColorOptions {
  readonly id: string;
  readonly name: string;
}

export type ThemeChoice = { kind: "builtin"; name: ThemeName } | { kind: "custom"; theme: CustomTheme };

export const modeKeys = {
  light: { theme: "lightTheme", accent: "lightAccent", colors: "lightColors", custom: "lightCustomTheme" },
  dark: { theme: "darkTheme", accent: "darkAccent", colors: "darkColors", custom: "darkCustomTheme" },
} as const;

const modes: readonly ThemeMode[] = ["light", "dark"];

const storedVariant = Schema.Struct({ palette: Schema.String, accent: Schema.String, colors: Schema.String });

const storedThemes = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, light: storedVariant, dark: storedVariant }),
);

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(storedThemes));

/** Invalid entries are dropped one by one so a single bad theme cannot hide the others. */
export function parseCustomThemes(raw: string | null): CustomTheme[] {
  if (!raw) return [];

  try {
    return decodeStored(raw).flatMap(({ id, name, light, dark }) => {
      const lightColors = unpackThemeColors(light.colors);
      const darkColors = unpackThemeColors(dark.colors);

      if (
        !id ||
        !isThemeName(light.palette) ||
        !isThemeName(dark.palette) ||
        !isAccent(light.accent) ||
        !isAccent(dark.accent) ||
        !lightColors ||
        !darkColors
      )
        return [];

      return [
        {
          id,
          name,
          lightTheme: colorThemes[light.palette],
          darkTheme: colorThemes[dark.palette],
          lightAccent: light.accent,
          darkAccent: dark.accent,
          lightColors,
          darkColors,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function serializeCustomThemes(themes: readonly CustomTheme[]): string {
  return JSON.stringify(
    themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      ...Object.fromEntries(
        modes.map((mode) => [
          mode,
          {
            palette: themeOf(theme, mode),
            accent: theme[modeKeys[mode].accent],
            colors: packThemeColors(theme[modeKeys[mode].colors]),
          },
        ]),
      ),
    })),
  );
}

export function colorOptionsOf(appearance: WebAppearance): ThemeColorOptions {
  const { lightTheme, darkTheme, lightAccent, darkAccent, lightColors, darkColors } = themeOptionsOf(appearance);

  return { lightTheme, darkTheme, lightAccent, darkAccent, lightColors, darkColors };
}

const customizedIn = (options: ThemeColorOptions, mode: ThemeMode) =>
  options[modeKeys[mode].accent] !== "palette" || Object.keys(options[modeKeys[mode].colors]).length > 0;

/** A built-in palette in one color scheme, without an accent preset or color overrides. */
export function builtinChoice(mode: ThemeMode, name: ThemeName): Partial<WebAppearance> {
  const keys = modeKeys[mode];

  return { [keys.theme]: colorThemes[name], [keys.accent]: "palette", [keys.colors]: {}, [keys.custom]: undefined };
}

/** The appearance keeps the resolved colors, so the first render needs no theme library. */
export function customChoice(mode: ThemeMode, theme: CustomTheme): Partial<WebAppearance> {
  const keys = modeKeys[mode];

  return {
    [keys.theme]: theme[keys.theme],
    [keys.accent]: theme[keys.accent],
    [keys.colors]: theme[keys.colors],
    [keys.custom]: theme.id,
  };
}

export function choiceOf(appearance: WebAppearance, mode: ThemeMode, library: readonly CustomTheme[]): ThemeChoice {
  const id = appearance[modeKeys[mode].custom];
  const theme = id === undefined ? undefined : library.find((candidate) => candidate.id === id);

  return theme ? { kind: "custom", theme } : { kind: "builtin", name: themeOf(appearance, mode) };
}

export function uniqueThemeName(library: readonly CustomTheme[], base = "Custom theme"): string {
  const taken = new Set(library.map((theme) => theme.name.trim().toLowerCase()));

  for (let index = 1; ; index += 1) {
    const name = index === 1 ? base : `${base} ${index}`;

    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function newCustomTheme(
  library: readonly CustomTheme[],
  options: ThemeColorOptions,
  name = uniqueThemeName(library),
): CustomTheme {
  return { id: crypto.randomUUID(), name, ...options };
}

/**
 * Colors applied without a theme in the library (from before custom themes, or a library that was cleared)
 * become a custom theme, so the picker can show and edit what the app uses.
 */
export function adoptAppliedColors(
  appearance: WebAppearance,
  library: readonly CustomTheme[],
): { theme: CustomTheme; change: Partial<WebAppearance> } | undefined {
  const options = colorOptionsOf(appearance);

  const orphaned = modes.filter((mode) => {
    const id = appearance[modeKeys[mode].custom];

    return id === undefined ? customizedIn(options, mode) : !library.some((theme) => theme.id === id);
  });

  if (!orphaned.length) return undefined;
  const theme = newCustomTheme(library, options);

  return {
    theme,
    change: Object.fromEntries(orphaned.map((mode) => [modeKeys[mode].custom, theme.id])),
  };
}

/** The appearance change that keeps every color scheme using `theme` in step with its saved colors. */
export function followTheme(appearance: WebAppearance, theme: CustomTheme): Partial<WebAppearance> {
  return Object.assign(
    {},
    ...modes.flatMap((mode) => (appearance[modeKeys[mode].custom] === theme.id ? [customChoice(mode, theme)] : [])),
  );
}

/** After a delete, each color scheme that used the theme keeps its base palette. */
export function dropTheme(appearance: WebAppearance, theme: CustomTheme): Partial<WebAppearance> {
  return Object.assign(
    {},
    ...modes.flatMap((mode) =>
      appearance[modeKeys[mode].custom] === theme.id ? [builtinChoice(mode, themeOf(theme, mode))] : [],
    ),
  );
}

export const sameColorOptions = (a: ThemeColorOptions, b: ThemeColorOptions) =>
  modes.every(
    (mode) =>
      themeOf(a, mode) === themeOf(b, mode) &&
      a[modeKeys[mode].accent] === b[modeKeys[mode].accent] &&
      packThemeColors(a[modeKeys[mode].colors]) === packThemeColors(b[modeKeys[mode].colors]),
  );
