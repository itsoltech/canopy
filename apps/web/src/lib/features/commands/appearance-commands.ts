import {
  namesOf,
  colorThemes,
  themeOf,
  chatWidthLabels,
  chatWidthNames,
  chatWidthOf,
  schemeLabels,
  schemeNames,
  schemeOf,
} from "#lib/features/settings/appearance.ts";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import type { IconName } from "#lib/shared/ui/icons.ts";
import type { Command } from "./registry.ts";
import { themes, themeNames } from "@canopy/ui/themes";

const SCHEME_ICONS = {
  system: "computer-desktop",
  light: "sun",
  dark: "moon",
} satisfies Record<keyof typeof schemeNames, IconName>;

/** Each theme command changes one variant; the other mode keeps its chosen palette. */
export function appearanceCommands(settings: SettingsState): Command[] {
  const appearance = settings.appearance;

  return [
    {
      id: "theme",
      title: "Change theme",
      group: "actions",
      icon: "swatch",
      keywords: "palette color colour light dark",
      placeholder: "Search themes…",
      rank: 11,
      searchChildren: true,
      children: () =>
        (["light", "dark"] as const).flatMap((mode) =>
          themeNames.map((name) => ({
            id: `${mode}-${name}`,
            title: `${themes[name].label} · ${mode === "light" ? "Light" : "Dark"}`,
            group: "actions",
            keywords: `theme palette ${mode}`,
            checked: themeOf(appearance, mode) === name,
            run: () =>
              void settings.updateAppearance(
                mode === "light" ? { lightTheme: colorThemes[name] } : { darkTheme: colorThemes[name] },
              ),
          })),
        ),
    },
    {
      id: "appearance",
      title: "Change appearance",
      group: "actions",
      icon: schemeOf(appearance) === "dark" ? "moon" : "sun",
      keywords: "color scheme dark light mode system",
      placeholder: "Search appearances…",
      rank: 12,
      searchChildren: true,
      children: () =>
        namesOf(schemeNames).map((name) => ({
          id: name,
          title: schemeLabels[name],
          group: "actions",
          icon: SCHEME_ICONS[name],
          keywords: "appearance color scheme mode",
          checked: schemeOf(appearance) === name,
          run: () => void settings.updateAppearance({ colorScheme: schemeNames[name] }),
        })),
    },
    {
      id: "chat-width",
      title: "Thread width",
      group: "actions",
      icon: "view-columns",
      keywords: "conversation layout wide narrow",
      rank: 13,
      searchChildren: true,
      children: () =>
        namesOf(chatWidthNames).map((name) => ({
          id: name,
          title: chatWidthLabels[name],
          group: "actions",
          keywords: "chat width",
          checked: chatWidthOf(appearance) === name,
          run: () => void settings.updateAppearance({ chatWidth: chatWidthNames[name] }),
        })),
    },
  ];
}
