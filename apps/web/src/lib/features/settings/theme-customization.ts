import { parseDeviceAppearance, type DeviceAppearance } from "@canopy/domain";
import { themeAccentNames, type ThemeAccent, type ThemeMode, type ThemeOverrides } from "@canopy/ui/themes";
import {
  cornerRadiusNames,
  packThemeColors,
  themeSpacingNames,
  unpackThemeColors,
  type ThemeColors,
  type ThemeTokenName,
} from "@canopy/ui/theme-builder";
import { Schema } from "effect";

export const cornerChoices = [
  { value: "square", label: "Square" },
  { value: "default", label: "Default" },
  { value: "rounded", label: "Rounded" },
] as const;

export const spacingChoices = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "spacious", label: "Spacious" },
] as const;

const accents = Schema.Literals(["palette", ...themeAccentNames]);
const corners = Schema.Literals(cornerRadiusNames);
const spacings = Schema.Literals(themeSpacingNames);

export const isAccent = Schema.is(accents);
export const isCorner = Schema.is(corners);
export const isSpacing = Schema.is(spacings);

const customization = Schema.Struct({
  lightAccent: Schema.optionalKey(accents),
  darkAccent: Schema.optionalKey(accents),
  cornerRadius: Schema.optionalKey(corners),
  spacing: Schema.optionalKey(spacings),
  lightCustomTheme: Schema.optional(Schema.String),
  darkCustomTheme: Schema.optional(Schema.String),
});

export type WebAppearance = DeviceAppearance &
  typeof customization.Type & {
    lightColors?: ThemeColors;
    darkColors?: ThemeColors;
  };

export type ThemeOptions = Required<
  Pick<
    WebAppearance,
    | "lightTheme"
    | "darkTheme"
    | "lightAccent"
    | "darkAccent"
    | "cornerRadius"
    | "spacing"
    | "lightColors"
    | "darkColors"
  >
>;

const noColors: ThemeColors = {};

export const themeCustomizationDefaults = {
  lightAccent: "palette",
  darkAccent: "palette",
  cornerRadius: "default",
  spacing: "default",
  lightColors: noColors,
  darkColors: noColors,
  lightCustomTheme: undefined,
  darkCustomTheme: undefined,
} as const satisfies Partial<WebAppearance>;

const storedCustomization = customization.mapFields((fields) => ({
  ...fields,
  lightColors: Schema.optionalKey(Schema.String),
  darkColors: Schema.optionalKey(Schema.String),
}));

const decodeCustomization = Schema.decodeUnknownSync(Schema.fromJsonString(storedCustomization));

export function parseWebAppearance(raw: string | null): WebAppearance | undefined {
  const base = parseDeviceAppearance(raw);

  if (!base) return undefined;

  try {
    const { lightColors, darkColors, ...options } = decodeCustomization(raw);

    return {
      ...base,
      ...options,
      lightColors: unpackThemeColors(lightColors ?? "") ?? noColors,
      darkColors: unpackThemeColors(darkColors ?? "") ?? noColors,
    };
  } catch {
    return base;
  }
}

export function serializeWebAppearance(appearance: WebAppearance): string {
  const { lightColors, darkColors, ...options } = appearance;

  return JSON.stringify({
    ...options,
    lightColors: lightColors && packThemeColors(lightColors),
    darkColors: darkColors && packThemeColors(darkColors),
  });
}

export function accentOf(
  theme: Pick<WebAppearance, "lightAccent" | "darkAccent"> | undefined,
  mode: ThemeMode,
): ThemeAccent | undefined {
  const accent = theme?.[mode === "light" ? "lightAccent" : "darkAccent"];

  return accent === "palette" ? undefined : accent;
}

export function themeOptionsOf(appearance: WebAppearance): ThemeOptions {
  return {
    lightTheme: appearance.lightTheme,
    darkTheme: appearance.darkTheme,
    lightAccent: appearance.lightAccent ?? themeCustomizationDefaults.lightAccent,
    darkAccent: appearance.darkAccent ?? themeCustomizationDefaults.darkAccent,
    cornerRadius: appearance.cornerRadius ?? themeCustomizationDefaults.cornerRadius,
    spacing: appearance.spacing ?? themeCustomizationDefaults.spacing,
    lightColors: appearance.lightColors ?? noColors,
    darkColors: appearance.darkColors ?? noColors,
  };
}

export function themeOverridesOf(appearance: Partial<ThemeOptions> | undefined, mode: ThemeMode): ThemeOverrides {
  return {
    accent: accentOf(appearance, mode),
    colors: mode === "light" ? appearance?.lightColors : appearance?.darkColors,
  };
}

export type ColorEdits = Readonly<Partial<Record<ThemeTokenName, string | null>>>;

export function editThemeColors(colors: ThemeColors, edits: ColorEdits): ThemeColors {
  if (!Object.keys(edits).length) return colors;
  const next = { ...colors };

  for (const [token, color] of Object.entries(edits)) {
    // SAFETY: ColorEdits only admits keys from the theme token list.
    const key = token as ThemeTokenName;

    if (color === null) delete next[key];
    else next[key] = color;
  }

  return next;
}
