import type { MessageInitShape } from "@bufbuild/protobuf";
import type { MentionCatalogEntrySchema } from "@canopy/contracts";

export type MentionEntryInit = MessageInitShape<typeof MentionCatalogEntrySchema>;

export interface ListedCatalog {
  readonly entries: MentionEntryInit[];
  readonly notes: string[];
}

/** How long a listing is reused when nothing it depends on changed (a refresh always lists again). */
export const CATALOG_TTL_MS = 5 * 60_000;

/**
 * Catalogs by provider + profile + folder. A listing is reused while its stamp (change times of the skill and command
 * folders) is the same and it is younger than CATALOG_TTL_MS; concurrent asks share one listing.
 */
export class CatalogCache {
  readonly #entries = new Map<string, { stamp: string; at: number; value: Promise<ListedCatalog> }>();

  get(key: string, stamp: string, load: () => Promise<ListedCatalog>, refresh: boolean, now = Date.now()): Promise<ListedCatalog> {
    const cached = this.#entries.get(key);
    if (!refresh && cached && cached.stamp === stamp && now - cached.at < CATALOG_TTL_MS) return cached.value;
    const value = load();
    this.#entries.set(key, { stamp, at: now, value });
    // A failed listing is not kept.
    value.catch(() => this.#entries.get(key)?.value === value && this.#entries.delete(key));
    if (this.#entries.size > 100) this.#entries.delete(this.#entries.keys().next().value ?? "");
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }
}
