import { Provider } from "@canopy/contracts";
import { useOverview, type OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { providerCall } from "#lib/features/providers/instances.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import type { ModelOption } from "./catalog.ts";

/**
 * Favorite models are the provider instance's (InstanceModels.favorites, docs/worker-config.md, 9.3), in the order
 * set in Settings → Providers: one list per instance, the same on every worker. The picker lists them under the star
 * (instance by instance, in their order) and gives the first nine ⌘1…⌘9; the star changes only the favorites (the
 * gateway sends the new lists to every picker through the overview).
 */
export interface FavoriteModels {
  has(option: ModelOption): boolean;
  toggle(option: ModelOption): void;
  /** The favorites among `options`, in the instances' order (one option each). */
  among(options: readonly ModelOption[]): ModelOption[];
}

class InstanceFavorites implements FavoriteModels {
  constructor(private readonly overview: OverviewState) {}

  has(option: ModelOption): boolean {
    return option.favoriteIndex !== undefined;
  }

  toggle(option: ModelOption): void {
    const harness = Provider[option.provider];
    const id = option.profileId || "native";

    const instance = this.overview.workers
      .flatMap((w) => w.providerInstances)
      .find((i) => i.harness === harness && i.id === id);

    const current = instance?.favorites ?? [];

    const favorites = current.includes(option.model)
      ? current.filter((m) => m !== option.model)
      : [...current, option.model];

    providerCall("models", { harness, id, favoritesOnly: true, models: { favorites } }).catch((cause: unknown) =>
      toast(cause instanceof Error ? cause.message : "Could not change the favorites", { tone: "error" }),
    );
  }

  among(options: readonly ModelOption[]): ModelOption[] {
    const instances = [...new Set(options.map((o) => `${o.provider}:${o.profileId}`))];
    const seen = new Set<string>();

    return options
      .filter((o) => o.favoriteIndex !== undefined && !seen.has(o.key) && seen.add(o.key))
      .sort(
        (a, b) =>
          instances.indexOf(`${a.provider}:${a.profileId}`) - instances.indexOf(`${b.provider}:${b.profileId}`) ||
          a.favoriteIndex! - b.favoriteIndex!,
      );
  }
}

/** Call during component setup (reads the overview context). */
export const useFavoriteModels = (): FavoriteModels => new InstanceFavorites(useOverview());
