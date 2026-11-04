import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { SIDEBAR_WIDTH, storedSidebarWidth } from "@canopy/domain";
import { accents, type AccentName } from "@canopy/ui";

/**
 * Appearance settings (stored by the gateway) as the attributes of `<html>` that layout.css reads:
 * `dark` class, `data-accent` (--brand-*), `data-chat-width` (--chat-width). The server renders them
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

export const chatWidthNames: Record<ChatWidthName, ui.ChatWidth> = {
  comfortable: ui.ChatWidth.COMFORTABLE,
  wide: ui.ChatWidth.WIDE,
  full: ui.ChatWidth.FULL,
};

const nameOf = <N extends string, V>(table: Record<N, V>, value: V, fallback: N): N =>
  (Object.keys(table) as N[]).find((name) => table[name] === value) ?? fallback;

/** Unspecified values are the defaults: system scheme, default accent, comfortable width. */
export const schemeOf = (appearance: ui.AppearanceSettings | undefined): SchemeName =>
  nameOf(schemeNames, appearance?.colorScheme, "system");

export const accentOf = (appearance: ui.AppearanceSettings | undefined): AccentName =>
  nameOf(accentNames, appearance?.accent, "default");

export const chatWidthOf = (appearance: ui.AppearanceSettings | undefined): ChatWidthName =>
  nameOf(chatWidthNames, appearance?.chatWidth, "comfortable");

/** Values for the `%canopy.*%` placeholders of app.html. */
export function documentAttributes(appearance: ui.AppearanceSettings | undefined): Record<string, string> {
  const scheme = schemeOf(appearance);

  return {
    "%canopy.dark%": scheme === "dark" ? " dark" : "",
    "%canopy.scheme%": scheme,
    "%canopy.colorSchemeMeta%": scheme === "system" ? "light dark" : scheme,
    "%canopy.accent%": accentOf(appearance),
    "%canopy.chatWidth%": chatWidthOf(appearance),
    "%canopy.sidebarWidth%": String(storedSidebarWidth(appearance?.sidebarWidth ?? 0) || SIDEBAR_WIDTH.default),
    "%canopy.sidebarCollapsed%": String(appearance?.sidebarCollapsed ?? false),
    "%canopy.threadPanelCollapsed%": String(appearance?.threadPanelCollapsed ?? false),
  };
}

/** Seed the SPA from the shell's gateway settings, before any client fetch or effect can change geometry. */
export function appearanceFromDocument(): ui.AppearanceSettings {
  const data = document.documentElement.dataset;

  return create(ui.AppearanceSettingsSchema, {
    colorScheme: schemeNames[data["colorScheme"] as SchemeName] ?? ui.ColorScheme.SYSTEM,
    accent: accentNames[data["accent"] as AccentName] ?? ui.AccentTheme.DEFAULT,
    chatWidth: chatWidthNames[data["chatWidth"] as ChatWidthName] ?? ui.ChatWidth.COMFORTABLE,
    sidebarWidth: Number(data["sidebarWidth"]) || SIDEBAR_WIDTH.default,
    sidebarCollapsed: data["sidebarCollapsed"] === "true",
    threadPanelCollapsed: data["threadPanelCollapsed"] === "true",
  });
}

/** Applies appearance to the live document (browser only); "system" follows prefers-color-scheme. */
export function applyAppearance(appearance: ui.AppearanceSettings | undefined): void {
  const root = document.documentElement;
  const scheme = schemeOf(appearance);
  root.classList.toggle(
    "dark",
    scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches),
  );
  root.dataset["colorScheme"] = scheme;
  root.dataset["accent"] = accentOf(appearance);
  root.dataset["chatWidth"] = chatWidthOf(appearance);
  root.dataset["sidebarWidth"] = String(appearance?.sidebarWidth || SIDEBAR_WIDTH.default);
  root.dataset["sidebarCollapsed"] = String(appearance?.sidebarCollapsed ?? false);
  root.dataset["threadPanelCollapsed"] = String(appearance?.threadPanelCollapsed ?? false);
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", scheme === "system" ? "light dark" : scheme);
}

/** Names of the choices as the settings and the command palette show them. */
export const schemeLabels: Record<SchemeName, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export const accentLabels = Object.fromEntries(accents.map((a) => [a.name, a.label])) as Record<AccentName, string>;

export const chatWidthLabels: Record<ChatWidthName, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full width",
};
