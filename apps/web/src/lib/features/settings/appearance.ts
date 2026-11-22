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
import type { DeviceViewValues } from "@canopy/domain/device-view";

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

export const themeOf = (appearance: DeviceAppearance | undefined, mode: ThemeMode): ThemeName =>
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
export function documentAttributes(appearance: DeviceAppearance | undefined): Map<string, string> {
  const scheme = schemeOf(appearance);

  return new Map([
    ["%canopy.dark%", scheme === "dark" ? " dark" : ""],
    ["%canopy.scheme%", appearance ? scheme : ""], // An empty scheme allows the desktop startup palette.
    ["%canopy.colorSchemeMeta%", scheme === "system" ? "light dark" : scheme],
    ["%canopy.lightTheme%", themeOf(appearance, "light")],
    ["%canopy.darkTheme%", themeOf(appearance, "dark")],
    ["%canopy.paletteStyle%", paletteStyle(themeOf(appearance, "light"), themeOf(appearance, "dark"))],
    ["%canopy.chatWidth%", chatWidthOf(appearance)],
    ["%canopy.sidebarWidth%", String(SIDEBAR_WIDTH.default)],
    ["%canopy.sidebarCollapsed%", "false"],
    ["%canopy.threadPanelCollapsed%", "false"],
  ]);
}

/** Read the palette the shell already painted, including the fallback from the desktop preload. */
export function appearanceFromDocument(): DeviceAppearance {
  const { colorScheme, chatWidth, lightTheme, darkTheme } = document.documentElement.dataset;

  return {
    colorScheme: isName(schemeChoices, colorScheme) ? schemeChoices[colorScheme].value : schemeChoices.system.value,
    lightTheme: isThemeName(lightTheme) ? colorThemes[lightTheme] : colorThemes.birch,
    darkTheme: isThemeName(darkTheme) ? colorThemes[darkTheme] : colorThemes.birch,
    chatWidth: isName(widthChoices, chatWidth) ? widthChoices[chatWidth].value : widthChoices.comfortable.value,
  };
}

/** Apply appearance to the live document. System follows prefers-color-scheme. */
export function applyAppearance(appearance: DeviceAppearance): void {
  const root = document.documentElement;
  const scheme = schemeOf(appearance);
  const light = themeOf(appearance, "light");
  const dark = themeOf(appearance, "dark");
  root.classList.toggle(
    "dark",
    scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches),
  );
  root.dataset["colorScheme"] = scheme;
  root.dataset["chatWidth"] = chatWidthOf(appearance);

  for (const [mode, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    root.dataset[`${mode}Theme`] = theme;

    for (const [key, value] of Object.entries(themeVariables(theme, mode)))
      root.style.setProperty(`--${mode}-${key}`, value);
  }

  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", scheme === "system" ? "light dark" : scheme);
  void window.canopyDesktop?.setAppearance?.({ scheme, light, dark }).catch(() => undefined);
}

export function applyViewGeometry(view: DeviceViewValues): void {
  const root = document.documentElement;
  root.dataset["sidebarWidth"] = String(view.sidebarWidth || SIDEBAR_WIDTH.default);
  root.dataset["sidebarCollapsed"] = String(view.sidebarCollapsed);
  root.dataset["threadPanelCollapsed"] = String(view.threadPanelCollapsed);
}
