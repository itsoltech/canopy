import { create } from "@bufbuild/protobuf";
import { ui, type ModelInfo } from "@canopy/contracts";

/**
 * An instance's models in the settings: rows from the catalog plus custom ids, and the instance's choices over them
 * (favorites, hidden, shown, custom), each change returning the whole new message.
 */

export interface ModelRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Capability tags from the catalog: reasoning (efforts), default. */
  readonly tags: readonly string[];
  readonly favorite: boolean;
  readonly hidden: boolean;
  readonly custom: boolean;
  /** The provider hides it by default (e.g. Codex hidden). */
  readonly providerHidden: boolean;
}

/**
 * The instance's models for the settings: the catalog's (as the workers list them, unfiltered) plus custom ones,
 * each with its visibility under the instance's choices; favorites in the user's order first.
 */
export function modelRows(catalog: readonly ModelInfo[], models: ui.InstanceModels | undefined): ModelRow[] {
  const favorites = models?.favorites ?? [];
  const hidden = new Set(models?.hidden ?? []);
  const shown = new Set(models?.shown ?? []);
  const rows: ModelRow[] = [];
  const seen = new Set<string>();

  for (const info of catalog) {
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    rows.push({
      id: info.id,
      name: info.displayName && info.displayName !== info.id ? info.displayName : info.id,
      description: info.description,
      tags: [...(info.efforts.length > 0 ? ["reasoning"] : []), ...(info.isDefault ? ["default"] : [])],
      favorite: favorites.includes(info.id),
      hidden: !(shown.has(info.id) || (!info.hidden && !hidden.has(info.id))),
      custom: false,
      providerHidden: info.hidden,
    });
  }

  for (const id of models?.custom ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      name: id,
      description: "",
      tags: ["custom"],
      favorite: favorites.includes(id),
      hidden: hidden.has(id),
      custom: true,
      providerHidden: false,
    });
  }

  const rank = new Map(favorites.map((id, i) => [id, i]));

  return [
    ...rows.filter((r) => r.favorite).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
    ...rows.filter((r) => !r.favorite),
  ];
}

const lists = (models: ui.InstanceModels | undefined) => ({
  favorites: [...(models?.favorites ?? [])],
  hidden: [...(models?.hidden ?? [])],
  shown: [...(models?.shown ?? [])],
  custom: [...(models?.custom ?? [])],
});

/** The instance's choices with one model shown or hidden (the provider's own hidden flag needs an explicit "shown"). */
export function withVisibility(
  models: ui.InstanceModels | undefined,
  row: Pick<ModelRow, "id" | "providerHidden">,
  visible: boolean,
): ui.InstanceModels {
  const hidden = new Set(models?.hidden ?? []);
  const shown = new Set(models?.shown ?? []);

  if (visible) {
    hidden.delete(row.id);

    if (row.providerHidden) shown.add(row.id);
  } else {
    shown.delete(row.id);
    hidden.add(row.id);
  }

  return create(ui.InstanceModelsSchema, { ...lists(models), hidden: [...hidden], shown: [...shown] });
}

export function withFavorite(models: ui.InstanceModels | undefined, id: string, favorite: boolean): ui.InstanceModels {
  const favorites = (models?.favorites ?? []).filter((f) => f !== id);

  return create(ui.InstanceModelsSchema, { ...lists(models), favorites: favorite ? [...favorites, id] : favorites });
}

/** A favorite moved one place up (-1) or down (1). */
export function withFavoriteMoved(models: ui.InstanceModels | undefined, id: string, by: -1 | 1): ui.InstanceModels {
  const favorites = [...(models?.favorites ?? [])];
  const from = favorites.indexOf(id);
  const to = from + by;

  if (from < 0 || to < 0 || to >= favorites.length) return create(ui.InstanceModelsSchema, lists(models));
  [favorites[from], favorites[to]] = [favorites[to]!, favorites[from]!];

  return create(ui.InstanceModelsSchema, { ...lists(models), favorites });
}

export function withCustom(models: ui.InstanceModels | undefined, id: string, add: boolean): ui.InstanceModels {
  const custom = (models?.custom ?? []).filter((c) => c !== id);
  const favorites = add ? (models?.favorites ?? []) : (models?.favorites ?? []).filter((f) => f !== id);

  return create(ui.InstanceModelsSchema, { ...lists(models), custom: add ? [...custom, id] : custom, favorites });
}

/** "Hide all" / "Show all" over the given rows. */
export function withAllVisible(
  models: ui.InstanceModels | undefined,
  rows: readonly ModelRow[],
  visible: boolean,
): ui.InstanceModels {
  return rows.reduce((acc, row) => withVisibility(acc, row, visible), create(ui.InstanceModelsSchema, lists(models)));
}

export const matchesModel = (row: ModelRow, query: string): boolean => {
  const q = query.trim().toLowerCase();

  return !q || `${row.id} ${row.name} ${row.description}`.toLowerCase().includes(q);
};
