import { ui } from "@open-agents/contracts";

/**
 * Appearance settings (stored by the gateway) as the attributes of `<html>` that layout.css reads:
 * `dark` class, `data-accent` (--brand-*), `data-chat-width` (--chat-width). The server renders them
 * into the page (hooks.server.ts), the browser updates them when the settings change.
 */
export type SchemeName = "system" | "light" | "dark";
export type AccentName = "default" | "grove" | "ocean" | "ember" | "iris" | "rose";
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

export const chatWidthNames: Record<ChatWidthName, ui.ChatWidth> = {
  comfortable: ui.ChatWidth.COMFORTABLE,
  wide: ui.ChatWidth.WIDE,
  full: ui.ChatWidth.FULL,
};

const nameOf = <N extends string, V>(table: Record<N, V>, value: V, fallback: N): N =>
  (Object.keys(table) as N[]).find((name) => table[name] === value) ?? fallback;

/** Unspecified values are the defaults: system scheme, default accent, comfortable width. */
export const schemeOf = (appearance: ui.AppearanceSettings | undefined): SchemeName => nameOf(schemeNames, appearance?.colorScheme, "system");
export const accentOf = (appearance: ui.AppearanceSettings | undefined): AccentName => nameOf(accentNames, appearance?.accent, "default");
export const chatWidthOf = (appearance: ui.AppearanceSettings | undefined): ChatWidthName => nameOf(chatWidthNames, appearance?.chatWidth, "comfortable");

/** Values for the `%oa.*%` placeholders of app.html. */
export function documentAttributes(appearance: ui.AppearanceSettings | undefined): Record<string, string> {
  const scheme = schemeOf(appearance);
  return {
    "%oa.dark%": scheme === "dark" ? " dark" : "",
    "%oa.scheme%": scheme,
    "%oa.colorSchemeMeta%": scheme === "system" ? "light dark" : scheme,
    "%oa.accent%": accentOf(appearance),
    "%oa.chatWidth%": chatWidthOf(appearance),
  };
}

/** Applies appearance to the live document (browser only); "system" follows prefers-color-scheme. */
export function applyAppearance(appearance: ui.AppearanceSettings | undefined): void {
  const root = document.documentElement;
  const scheme = schemeOf(appearance);
  root.classList.toggle("dark", scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
  root.dataset["colorScheme"] = scheme;
  root.dataset["accent"] = accentOf(appearance);
  root.dataset["chatWidth"] = chatWidthOf(appearance);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", scheme === "system" ? "light dark" : scheme);
}
