import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@open-agents/contracts";
import { useSettings, type SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import type { ModelOption } from "./catalog.ts";

/**
 * Your favorite models, in the order you starred them: a user setting kept by the gateway
 * (`UserSettings.model_favorites`, written like the other sections, so it follows you across devices).
 * The picker lists them under the star and gives the first nine ⌘1…⌘9. A star shows at once; a failed
 * write reloads the settings, which takes it back.
 *
 * A favorite names provider, profile and model; an empty profile matches the model on any profile. The
 * native profile is stored as "native" (the forms' "" would mean "any").
 */
export interface FavoriteModels {
  has(option: ModelOption): boolean;
  toggle(option: ModelOption): void;
  /** The favorites among `options`, in your order (one option each). */
  among(options: readonly ModelOption[]): ModelOption[];
}

const storedProfile = (profileId: string) => profileId || "native";
const matches = (favorite: ui.FavoriteModel, option: ModelOption) =>
  favorite.provider === Provider[option.provider] && favorite.model === option.model && (!favorite.profileId || favorite.profileId === storedProfile(option.profileId));

class SettingsFavorites implements FavoriteModels {
  constructor(private readonly settings: SettingsState) {}

  has(option: ModelOption): boolean {
    return this.settings.modelFavorites.some((f) => matches(f, option));
  }

  toggle(option: ModelOption): void {
    const current = this.settings.modelFavorites;
    const next = this.has(option)
      ? current.filter((f) => !matches(f, option))
      : [...current, create(ui.FavoriteModelSchema, { provider: Provider[option.provider], profileId: storedProfile(option.profileId), model: option.model })];
    void this.settings.updateModelFavorites(next);
  }

  among(options: readonly ModelOption[]): ModelOption[] {
    const seen = new Set<string>();
    return this.settings.modelFavorites.flatMap((favorite) => {
      const option = options.find((o) => !seen.has(o.key) && matches(favorite, o));
      if (!option) return [];
      seen.add(option.key);
      return [option];
    });
  }
}

/** Call during component setup (reads the settings context). */
export const useFavoriteModels = (): FavoriteModels => new SettingsFavorites(useSettings());
