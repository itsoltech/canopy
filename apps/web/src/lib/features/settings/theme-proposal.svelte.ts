import { untrack } from "svelte";
import { decodeThemeBuilderPatch } from "@canopy/ui/theme-builder";
import type { ThemeMode } from "@canopy/ui/themes";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { colorOptionsOf, newCustomTheme, uniqueThemeName, type CustomTheme } from "./custom-themes.ts";
import { customThemes } from "./custom-themes.svelte.ts";
import { useSettingsRoute } from "./settings-route.ts";
import { useSettings } from "./settings-state.svelte.ts";
import type { ThemeOptions } from "./theme-customization.ts";

/** What the theme editor opens with. */
export interface ThemeEditing {
  theme: CustomTheme;
  created: boolean;
  shape?: Partial<Pick<ThemeOptions, "cornerRadius" | "spacing">>;
  mode?: ThemeMode;
}

/**
 * A bot's Review theme link opens Appearance with `?theme=`. The proposal becomes a new custom theme based on the
 * colors in use, so the owner reviews it in the editor before saving.
 */
export function useThemeProposal(open: (editing: ThemeEditing) => void): void {
  const route = useSettingsRoute();
  const settings = useSettings();
  let seen: string | null = null;

  function stage(encoded: string) {
    const patch = decodeThemeBuilderPatch(encoded);

    if (!patch) {
      toast("Could not open this theme. Ask for a new theme link.", { tone: "error" });

      return;
    }

    const { light, dark, ...shape } = patch;
    const options = colorOptionsOf(settings.appearance);
    const library = customThemes.list;

    const theme = newCustomTheme(
      library,
      {
        ...options,
        lightColors: { ...options.lightColors, ...light },
        darkColors: { ...options.darkColors, ...dark },
      },
      uniqueThemeName(library, "Proposed theme"),
    );

    open({ theme, created: true, shape, mode: dark && !light ? "dark" : "light" });
  }

  $effect(() => {
    const encoded = route.url.searchParams.get("theme");

    if (!encoded) {
      seen = null;

      return;
    }

    if (encoded !== seen) {
      seen = encoded;
      untrack(() => stage(encoded));
    }

    void route.consumeQuery("theme");
  });
}
