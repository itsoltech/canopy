import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export interface Listing {
  /** The real path the worker listed. */
  readonly path: string;
  /** Subdirectory names, sorted like a file manager (case-insensitive). */
  readonly names: readonly string[];
  /** Names of subdirectories that are Git repositories. */
  readonly git: ReadonlySet<string>;
}

/**
 * Directories of one worker for the add-project browser, through the same routed `ListDirectory` as the
 * workspace picker (a linked computer's worker answers at its home). Each directory is fetched once per open
 * dialog; the latest request wins, so fast typing never shows an older directory.
 */
export class DirectoryListing {
  readonly #cache = new Map<string, Promise<Listing>>();
  #latest = 0;
  current = $state.raw<Listing | undefined>(undefined);
  loading = $state(false);
  error = $state<string | undefined>(undefined);

  constructor(readonly workerId: string) {}

  #fetch(path: string): Promise<Listing> {
    let listing = this.#cache.get(path);

    if (!listing) {
      listing = requestJson(
        "GET",
        `/api/workers/${encodeURIComponent(this.workerId)}/directory?${new URLSearchParams({ path })}`,
        undefined,
        20_000,
      ).then((payload) => {
        const response = decode(ui.ListDirectoryResponseSchema, payload);

        const directories = response.entries.filter((entry) => entry.isDir);

        return {
          path: response.path,
          names: directories
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
          git: new Set(directories.filter((entry) => entry.isGitRepo).map((entry) => entry.name)),
        };
      });
      listing.catch(() => this.#cache.delete(path));
      this.#cache.set(path, listing);
    }

    return listing;
  }

  /** The worker's home directory ("" asks the worker for it). */
  home(): Promise<Listing> {
    return this.#fetch("");
  }

  async open(path: string): Promise<void> {
    const request = ++this.#latest;
    this.loading = true;

    try {
      const listing = await this.#fetch(path);

      if (request !== this.#latest) return;
      this.current = listing;
      this.error = undefined;
    } catch (cause) {
      if (request !== this.#latest) return;
      this.current = undefined;
      this.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (request === this.#latest) this.loading = false;
    }
  }
}
