/**
 * Your favorite models (`ModelOption.key`s, in the order you starred them). The picker lists them under
 * the star and gives the first nine ⌘1…⌘9.
 *
 * PENDING backend: favorites are a user setting kept by the gateway (`UserSettings.favorite_models`,
 * written through `UpdateUserSettings` like the other sections). Until that field exists they live in
 * memory for this tab only — no browser storage. Wiring the setting in means changing this module only:
 * read `settings.user.favoriteModels`, write with a settings update.
 */
export interface FavoriteModels {
  readonly keys: readonly string[];
  has(key: string): boolean;
  toggle(key: string): void;
}

class MemoryFavorites implements FavoriteModels {
  // Changed only from the browser (clicks, keys), so the server render always starts empty.
  keys = $state<string[]>([]);

  has(key: string): boolean {
    return this.keys.includes(key);
  }

  toggle(key: string): void {
    this.keys = this.has(key) ? this.keys.filter((k) => k !== key) : [...this.keys, key];
  }
}

const favorites = new MemoryFavorites();

export const useFavoriteModels = (): FavoriteModels => favorites;
