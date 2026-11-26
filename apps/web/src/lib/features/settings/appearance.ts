import { ui } from "@canopy/contracts";
import {
  appearanceChoiceKey,
  colorSchemePreference,
  SIDEBAR_WIDTH,
  threadWidthPreference,
  type DeviceAppearance,
} from "@canopy/domain";
import {
  isThemeName,
  paletteStyle,
  themeNames,
  themeVariables,
  type ThemeName,
  type ThemeMode,
} from "@canopy/ui/themes";
import type { DesktopAppearance } from "@canopy/ui/desktop";
import { packThemeColors, unpackThemeColors } from "@canopy/ui/theme-builder";
import type { DeviceViewValues } from "@canopy/domain/device-view";
import { themeCustomizationDefaults, themeOverridesOf, type WebAppearance } from "./theme-customization.ts";
import type { ThemePreview } from "./settings-theme-preview.ts";

export const appearanceCookie = "canopy-appearance";
export const schemeChoices = colorSchemePreference.choices;
export const widthChoices = threadWidthPreference.choices;

export const colorThemes: Record<ThemeName, ui.ColorTheme> = {
  birch: ui.ColorTheme.BIRCH,
  fern: ui.ColorTheme.FERN,
  lagoon: ui.ColorTheme.LAGOON,
  cedar: ui.ColorTheme.CEDAR,
  heather: ui.ColorTheme.HEATHER,
  blossom: ui.ColorTheme.BLOSSOM,
  ash: ui.ColorTheme.ASH,
};

export const themeOf = (
  appearance: Pick<DeviceAppearance, "lightTheme" | "darkTheme"> | undefined,
  mode: ThemeMode,
): ThemeName =>
  themeNames.find((name) => colorThemes[name] === appearance?.[mode === "light" ? "lightTheme" : "darkTheme"]) ??
  "birch";

/** The names of a name table in its order. */
export const namesOf = <N extends string, V>(table: Readonly<Record<N, V>>): N[] =>
  // SAFETY: the name tables are object literals typed with exactly their name union, so their own keys are N.
  Object.keys(table) as N[];

const isName = <N extends string, V>(table: Readonly<Record<N, V>>, value: string | undefined): value is N =>
  value !== undefined && Object.hasOwn(table, value);

export const schemeOf = (appearance: DeviceAppearance | undefined) =>
  appearanceChoiceKey(schemeChoices, appearance?.colorScheme, colorSchemePreference.defaultChoice);

export const chatWidthOf = (appearance: DeviceAppearance | undefined) =>
  appearanceChoiceKey(widthChoices, appearance?.chatWidth, threadWidthPreference.defaultChoice);

/** Values for the `%canopy.*%` placeholders of app.html. */
export function documentAttributes(appearance: WebAppearance | undefined): Map<string, string> {
  const scheme = schemeOf(appearance);
  const light = themeOf(appearance, "light");
  const dark = themeOf(appearance, "dark");

  return new Map([
    ["%canopy.dark%", scheme === "dark" ? " dark" : ""],
    ["%canopy.scheme%", appearance ? scheme : ""], // An empty scheme allows the desktop startup palette.
    ["%canopy.colorSchemeMeta%", scheme === "system" ? "light dark" : scheme],
    ["%canopy.lightTheme%", light],
    ["%canopy.darkTheme%", dark],
    [
      "%canopy.paletteStyle%",
      paletteStyle(light, dark, {
        light: themeOverridesOf(appearance, "light"),
        dark: themeOverridesOf(appearance, "dark"),
      }),
    ],
    ["%canopy.cornerRadius%", appearance?.cornerRadius ?? themeCustomizationDefaults.cornerRadius],
    ["%canopy.themeSpacing%", appearance?.spacing ?? themeCustomizationDefaults.spacing],
    ["%canopy.chatWidth%", chatWidthOf(appearance)],
    ["%canopy.sidebarWidth%", String(SIDEBAR_WIDTH.default)],
    ["%canopy.sidebarCollapsed%", "false"],
    ["%canopy.threadPanelCollapsed%", "false"],
  ]);
}

/** Read the palette the shell already painted, including the fallback from the desktop preload. */
export function appearanceFromDocument(): WebAppearance {
  const { colorScheme, chatWidth, lightTheme, darkTheme } = document.documentElement.dataset;

  const base: DeviceAppearance = {
    colorScheme: isName(schemeChoices, colorScheme) ? schemeChoices[colorScheme].value : schemeChoices.system.value,
    lightTheme: isThemeName(lightTheme) ? colorThemes[lightTheme] : colorThemes.birch,
    darkTheme: isThemeName(darkTheme) ? colorThemes[darkTheme] : colorThemes.birch,
    chatWidth: isName(widthChoices, chatWidth) ? widthChoices[chatWidth].value : widthChoices.comfortable.value,
  };

  const startup = window.canopyDesktop?.startupAppearance;

  if (!startup) return base;

  return {
    ...base,
    lightAccent: startup.lightAccent ?? themeCustomizationDefaults.lightAccent,
    darkAccent: startup.darkAccent ?? themeCustomizationDefaults.darkAccent,
    lightColors: unpackThemeColors(startup.lightColors ?? "") ?? themeCustomizationDefaults.lightColors,
    darkColors: unpackThemeColors(startup.darkColors ?? "") ?? themeCustomizationDefaults.darkColors,
  };
}

/** Apply appearance to the live document. System follows prefers-color-scheme. */
export function applyAppearance(appearance: WebAppearance, preview?: ThemePreview): void {
  const root = document.documentElement;
  const options = preview?.options ?? appearance;
  const scheme = preview?.mode ?? schemeOf(appearance);
  root.classList.toggle(
    "dark",
    scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches),
  );
  root.dataset["colorScheme"] = scheme;
  root.dataset["chatWidth"] = chatWidthOf(appearance);
  root.dataset.cornerRadius = options.cornerRadius ?? themeCustomizationDefaults.cornerRadius;
  root.dataset.themeSpacing = options.spacing ?? themeCustomizationDefaults.spacing;

  for (const mode of ["light", "dark"] as const) {
    const theme = themeOf(options, mode);
    root.dataset[`${mode}Theme`] = theme;

    for (const [key, value] of Object.entries(themeVariables(theme, mode, themeOverridesOf(options, mode))))
      root.style.setProperty(`--${mode}-${key}`, value);
  }

  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", scheme === "system" ? "light dark" : scheme);
}

/** The renderer can preview a draft while native chrome uses the saved appearance. */
export function applyDesktopAppearance(appearance: WebAppearance): void {
  if (!window.canopyDesktop?.setAppearance) return;

  const native: DesktopAppearance = {
    scheme: schemeOf(appearance),
    light: themeOf(appearance, "light"),
    dark: themeOf(appearance, "dark"),
  };

  for (const mode of ["light", "dark"] as const) {
    const overrides = themeOverridesOf(appearance, mode);

    if (overrides.accent) native[`${mode}Accent`] = overrides.accent;

    if (overrides.colors) native[`${mode}Colors`] = packThemeColors(overrides.colors);
  }

  void window.canopyDesktop.setAppearance(native).catch(() => undefined);
}

export function applyViewGeometry(view: DeviceViewValues): void {
  const root = document.documentElement;
  root.dataset["sidebarWidth"] = String(view.sidebarWidth || SIDEBAR_WIDTH.default);
  root.dataset["sidebarCollapsed"] = String(view.sidebarCollapsed);
  root.dataset["threadPanelCollapsed"] = String(view.threadPanelCollapsed);
}
