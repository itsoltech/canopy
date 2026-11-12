import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { queries } from "#lib/shared/queries.svelte.ts";

interface SavedPages<T> {
  pages: T[];
  index: number;
}

/** A single visible page stays mounted. Returning to a loaded page preserves its position. */
export class PullRequestPages<T extends { page?: github.PullRequestPageInfo }> {
  pages = $state.raw<T[]>([]);
  #index = $state(0);
  busy = $state(false);
  error = $state("");
  #request = 0;
  #queued: { retain: boolean; refresh: boolean } | undefined;
  constructor(
    readonly load: (cursor: string, refresh: boolean) => Promise<T>,
    readonly key = "",
  ) {
    const saved = key ? queries.snapshot<SavedPages<T>>(key).data : undefined;

    if (saved) {
      this.pages = saved.pages;
      this.#index = saved.index;
    }
  }
  get index() {
    return this.#index;
  }
  set index(value: number) {
    this.#index = value;
    this.save();
  }
  private save() {
    if (this.key) queries.set(this.key, { pages: this.pages, index: this.index });
  }
  get current() {
    return this.pages[this.index];
  }
  async invalidate(retainCurrent = false, refresh = true) {
    if (this.busy) {
      this.#queued = {
        retain: (this.#queued?.retain ?? true) && retainCurrent,
        refresh: (this.#queued?.refresh ?? false) || refresh,
      };

      return;
    }

    if (retainCurrent) return this.read(false, refresh);
    // Refresh the loaded window without discarding rows, their keys or expansion state.
    const count = Math.max(1, this.pages.length);

    for (let index = 0; index < count; index++) {
      await this.read(false, refresh, index);

      if (this.error || !this.pages[index]?.page?.nextCursor) break;
    }
  }
  async read(next = false, refresh = false, at = this.index) {
    if (this.busy) return;

    const cursor = next
      ? (this.current?.page?.nextCursor ?? "")
      : at
        ? (this.pages[at - 1]?.page?.nextCursor ?? "")
        : "";

    const run = ++this.#request;
    this.busy = true;
    this.error = "";

    try {
      const value = await this.load(cursor, refresh);

      if (run !== this.#request) return;

      if (next) {
        this.pages = [...this.pages.slice(0, this.index + 1), value];
        this.index++;
      } else this.pages = [...this.pages.slice(0, at), value, ...this.pages.slice(at + 1)];
      this.save();
    } catch {
      if (run === this.#request) this.error = "Could not load this page. Retry.";
    } finally {
      if (run === this.#request) {
        this.busy = false;

        if (this.#queued !== undefined) {
          const queued = this.#queued;
          this.#queued = undefined;
          void this.invalidate(queued.retain, queued.refresh);
        }
      }
    }
  }
  request(id: string, cursor: string) {
    return create(github.PullRequestPageRequestSchema, { pullRequestId: id, cursor });
  }
}
