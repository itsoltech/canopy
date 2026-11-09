import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { SIDEBAR_WIDTH, storedSidebarWidth } from "@canopy/domain";
import { accents, type AccentName } from "@canopy/ui";
import { isThemeName, paletteStyle, themeVariables, type ThemeName, type ThemeMode } from "@canopy/ui/themes";
import type { DeviceViewValues } from "@canopy/domain/device-view";

/**
 * Appearance settings (stored by the gateway) as the attributes of `<html>` that layout.css reads:
 * `dark` class, `data-light-theme` / `data-dark-theme` (full palettes), `data-chat-width`. The server renders them
 * into the page (hooks.server.ts), the browser updates them when the settings change.
 */
export type SchemeName = "system" | "light" | "dark";

export type { AccentName } from "@canopy/ui";

export type ChatWidthName = "comfortable" | "wide" | "full";

export const schemeNames: Record<SchemeName, ui.ColorScheme> = {
  system: ui.ColorScheme.SYSTEM,
  light: ui.ColorScheme.LIGHT,
  dark: ui.ColorScheme.DARK,
};

export const accentNames: Record<AccentName, ui.AccentTheme> = {
  default: ui.AccentTheme.DEFAULT,
  grove: ui.AccentTheme.GROVE,
  ocean: ui.AccentTheme.OCEAN,
  ember: ui.AccentTheme.EMBER,
  iris: ui.AccentTheme.IRIS,
  rose: ui.AccentTheme.ROSE,
};

export const colorThemes: Record<ThemeName, ui.ColorTheme> = {
  birch: ui.ColorTheme.BIRCH,
  fern: ui.ColorTheme.FERN,
  lagoon: ui.ColorTheme.LAGOON,
  cedar: ui.ColorTheme.CEDAR,
  heather: ui.ColorTheme.HEATHER,
  blossom: ui.ColorTheme.BLOSSOM,
  ash: ui.ColorTheme.ASH,
};

const previousThemes: Record<AccentName, ThemeName> = {
  default: "birch",
  grove: "fern",
  ocean: "lagoon",
  ember: "cedar",
  iris: "heather",
  rose: "blossom",
};

/** An absent mode inherits the saved accent; choosing the other mode never overwrites it. */
export const themeOf = (appearance: ui.AppearanceSettings | undefined, mode: ThemeMode): ThemeName =>
  nameOf(
    colorThemes,
    appearance?.[mode === "light" ? "lightTheme" : "darkTheme"],
    previousThemes[accentOf(appearance)],
  );

export const chatWidthNames: Record<ChatWidthName, ui.ChatWidth> = {
  comfortable: ui.ChatWidth.COMFORTABLE,
  wide: ui.ChatWidth.WIDE,
  full: ui.ChatWidth.FULL,
};

/** The names of a name table (`schemeNames`, `accentNames`, `chatWidthNames`), in its order. */
export const namesOf = <N extends string, V>(table: Readonly<Record<N, V>>): N[] =>
  // SAFETY: the name tables are object literals typed with exactly their name union, so their own keys are N.
  Object.keys(table) as N[];

/** A name of the table (a data attribute, a query value), told apart from any other text. */
const isName = <N extends string, V>(table: Readonly<Record<N, V>>, value: string | undefined): value is N =>
  value !== undefined && Object.hasOwn(table, value);

const nameOf = <N extends string, V>(table: Record<N, V>, value: V, fallback: N): N =>
  namesOf(table).find((name) => table[name] === value) ?? fallback;

/** Unspecified values are the defaults: system scheme, default accent, comfortable width. */
export const schemeOf = (appearance: ui.AppearanceSettings | undefined): SchemeName =>
  nameOf(schemeNames, appearance?.colorScheme, "system");

export const accentOf = (appearance: ui.AppearanceSettings | undefined): AccentName =>
  nameOf(accentNames, appearance?.accent, "default");

export const chatWidthOf = (appearance: ui.AppearanceSettings | undefined): ChatWidthName =>
  nameOf(chatWidthNames, appearance?.chatWidth, "comfortable");

/** Values for the `%canopy.*%` placeholders of app.html. */
export function documentAttributes(appearance: ui.AppearanceSettings | undefined): Map<string, string> {
  const scheme = schemeOf(appearance);

  return new Map([
    ["%canopy.dark%", scheme === "dark" ? " dark" : ""],
    ["%canopy.scheme%", scheme],
    ["%canopy.colorSchemeMeta%", scheme === "system" ? "light dark" : scheme],
    ["%canopy.accent%", accentOf(appearance)],
    ["%canopy.lightTheme%", themeOf(appearance, "light")],
    ["%canopy.darkTheme%", themeOf(appearance, "dark")],
    ["%canopy.paletteStyle%", paletteStyle(themeOf(appearance, "light"), themeOf(appearance, "dark"))],
    ["%canopy.chatWidth%", chatWidthOf(appearance)],
    ["%canopy.sidebarWidth%", String(storedSidebarWidth(appearance?.sidebarWidth ?? 0) || SIDEBAR_WIDTH.default)],
    ["%canopy.sidebarCollapsed%", String(appearance?.sidebarCollapsed ?? false)],
    ["%canopy.threadPanelCollapsed%", String(appearance?.threadPanelCollapsed ?? false)],
  ]);
}

/** Seed the SPA from the shell's gateway settings, before any client fetch or effect can change geometry. */
export function appearanceFromDocument(): ui.AppearanceSettings {
  const data = document.documentElement.dataset;
  const { colorScheme, accent, chatWidth, lightTheme, darkTheme } = data;

  return create(ui.AppearanceSettingsSchema, {
    colorScheme: isName(schemeNames, colorScheme) ? schemeNames[colorScheme] : ui.ColorScheme.SYSTEM,
    accent: isName(accentNames, accent) ? accentNames[accent] : ui.AccentTheme.DEFAULT,
    lightTheme: isThemeName(lightTheme) ? colorThemes[lightTheme] : ui.ColorTheme.UNSPECIFIED,
    darkTheme: isThemeName(darkTheme) ? colorThemes[darkTheme] : ui.ColorTheme.UNSPECIFIED,
    chatWidth: isName(chatWidthNames, chatWidth) ? chatWidthNames[chatWidth] : ui.ChatWidth.COMFORTABLE,
    sidebarWidth: Number(data["sidebarWidth"]) || SIDEBAR_WIDTH.default,
    sidebarCollapsed: data["sidebarCollapsed"] === "true",
    threadPanelCollapsed: data["threadPanelCollapsed"] === "true",
  });
}

/** Applies appearance to the live document (browser only); "system" follows prefers-color-scheme. */
export function applyAppearance(appearance: ui.AppearanceSettings | undefined, view: DeviceViewValues): void {
  const root = document.documentElement;
  const scheme = schemeOf(appearance);
  root.classList.toggle(
    "dark",
    scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches),
  );
  root.dataset["colorScheme"] = scheme;
  root.dataset["accent"] = accentOf(appearance);

  for (const mode of ["light", "dark"] as const) {
    const theme = themeOf(appearance, mode);
    root.dataset[`${mode}Theme`] = theme;

    for (const [key, value] of Object.entries(themeVariables(theme, mode)))
      root.style.setProperty(`--${mode}-${key}`, value);
  }

  root.dataset["chatWidth"] = chatWidthOf(appearance);
  root.dataset["sidebarWidth"] = String(view.sidebarWidth || SIDEBAR_WIDTH.default);
  root.dataset["sidebarCollapsed"] = String(view.sidebarCollapsed);
  root.dataset["threadPanelCollapsed"] = String(view.threadPanelCollapsed);
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", scheme === "system" ? "light dark" : scheme);
  void window.canopyDesktop
    ?.setAppearance?.({
      scheme,
      light: themeOf(appearance, "light"),
      dark: themeOf(appearance, "dark"),
    })
    .catch(() => undefined);
}

/** Names of the choices as the settings and the command palette show them. */
export const schemeLabels: Record<SchemeName, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export const accentLabel = (name: AccentName): string => accents.find((a) => a.name === name)?.label ?? name;

export const chatWidthLabels: Record<ChatWidthName, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full width",
};
