import type { ui } from "@canopy/contracts";

export interface ArchivedFilter {
  projectIds: string[];
  query: string;
}

export interface ArchivedPageState {
  threads: ui.Thread[];
  sideThreads: ui.Thread[];
  totalCount: number | undefined;
  nextPageToken: string;
  /** `threads` hold a fetched page for this filter (a collapsed section may have only its count). */
  loaded: boolean;
  loading: boolean;
  error: string;
}

type Load = (
  request: ArchivedFilter & { pageToken: string; countOnly: boolean },
) => Promise<ui.ListArchivedThreadsResponse>;

const empty = (): ArchivedPageState => ({
  threads: [],
  sideThreads: [],
  totalCount: undefined,
  nextPageToken: "",
  loaded: false,
  loading: false,
  error: "",
});

/** Latest request wins. Live invalidations rebuild the loaded pages using fresh keyset cursors;
 * a collapsed section fetches only its count, and never downloads the archive in the overview.
 * The first page can be prefetched while collapsed (`prefetch`, on intent or idle) and stays as a
 * cache: opening shows it at once, and refetches only when a change (`version`) made it stale. */
export class ArchivedThreadsPager {
  state = empty();
  #epoch = 0;
  #pages = 1;
  #key = "";
  #version = "";
  #expanded = false;
  /** The cached first page matches the current version (no change since it was fetched). */
  #fresh = false;
  #first: Pick<ArchivedPageState, "threads" | "sideThreads" | "nextPageToken"> | undefined;
  #prefetching: Promise<void> | undefined;
  #filter: ArchivedFilter = { projectIds: [], query: "" };
  constructor(
    private load: Load,
    private changed: (state: ArchivedPageState) => void,
    private saved?: (filter: ArchivedFilter) => ArchivedPageState | undefined,
    private remember?: (filter: ArchivedFilter, state: ArchivedPageState) => void,
    private revision?: () => number,
  ) {}
  #set(change: Partial<ArchivedPageState>) {
    this.state = { ...this.state, ...change };
    this.changed(this.state);
  }

  /** `version` changes whenever the archive may have changed (stream updates, reconnects). */
  async refresh(filter: ArchivedFilter, expanded: boolean, version = ""): Promise<void> {
    const key = JSON.stringify([[...filter.projectIds].sort(), filter.query.trim().toLowerCase()]);
    const filterChanged = key !== this.#key;

    if (filterChanged) {
      this.#key = key;
      this.#pages = 1;
      this.#fresh = false;
      this.#first = undefined;
      this.#prefetching = undefined;
      this.state = this.saved?.(filter) ?? empty();
      // Saved peer rows do not consume the local archive endpoint's keyset pages.
      this.#pages = this.state.loaded
        ? Math.max(1, Math.ceil(this.state.threads.filter((thread) => !thread.nodeId).length / 20))
        : 1;
    }

    const changed = filterChanged || version !== this.#version;

    if (changed) {
      this.#version = version;
      this.#fresh = false;
    }

    const opening = expanded && !this.#expanded;
    const closing = !expanded && this.#expanded;

    if (expanded !== this.#expanded && !this.saved) this.#pages = 1;
    this.#filter = filter;
    this.#expanded = expanded;

    // Collapsed: keep only the first page as the cache for the next opening.
    if (closing && this.#first && !this.saved) this.#set({ ...this.#first });

    if (!changed && !opening && this.state.totalCount !== undefined && !this.state.error) {
      // Nothing changed since the count / pages (a settings write re-ran the caller): no request, and
      // closing drops a pending "load more".
      if (closing) {
        this.#epoch += 1;
        this.#set({ loading: false });
      }

      return;
    }

    if (opening && !changed) {
      if (this.#prefetching) {
        const epoch = this.#epoch;
        await this.#prefetching;

        if (epoch !== this.#epoch) return; // a newer request owns the state
      }

      if (this.#fresh) return;
    }

    const epoch = ++this.#epoch;
    this.#set({ loading: true, error: "" });

    if (expanded) return this.#loadPages(epoch, this.#pages);

    try {
      const page = await this.load({ ...filter, pageToken: "", countOnly: true });

      if (epoch === this.#epoch) this.#set({ totalCount: page.totalCount, loading: false });
    } catch (cause) {
      if (epoch === this.#epoch) this.#set({ loading: false, error: message(cause) });
    }
  }

  /** Warm the first page while collapsed (hover, focus, idle): cheap, once per change, errors stay quiet. */
  prefetch(): void {
    if (this.#expanded || !this.#key || this.#fresh || this.#prefetching || this.state.totalCount === 0) return;
    const epoch = ++this.#epoch;
    this.#set({ loading: true });

    const run = this.#loadPages(epoch, this.saved ? this.#pages : 1, true).finally(() => {
      if (this.#prefetching === run) this.#prefetching = undefined;
    });

    this.#prefetching = run;
  }

  async more(): Promise<void> {
    if (!this.#expanded || this.state.loading || !this.state.nextPageToken) return;
    this.state = this.saved?.(this.#filter) ?? this.state;
    const epoch = ++this.#epoch;
    const revision = this.revision?.();
    this.#set({ loading: true, error: "" });

    try {
      const page = await this.load({ ...this.#filter, pageToken: this.state.nextPageToken, countOnly: false });

      if (!this.#current(epoch, revision)) return;
      this.#pages += 1;
      this.#set({
        threads: unique([...this.state.threads, ...page.threads]),
        sideThreads: unique([...this.state.sideThreads, ...page.sideThreads]),
        totalCount: page.totalCount,
        nextPageToken: page.nextPageToken,
        loading: false,
      });
      this.remember?.(this.#filter, this.state);
    } catch (cause) {
      if (epoch === this.#epoch) this.#set({ loading: false, error: message(cause) });
    }
  }

  dispose() {
    this.#epoch += 1;
  }

  async #loadPages(epoch: number, pages: number, quiet = false): Promise<void> {
    const revision = this.revision?.();

    try {
      const threads: ui.Thread[] = [];
      const sideThreads: ui.Thread[] = [];
      let pageToken = "";
      let first = this.#first;

      for (let i = 0; i < pages; i++) {
        const page = await this.load({ ...this.#filter, pageToken, countOnly: false });

        if (!this.#current(epoch, revision)) return;

        if (i === 0)
          first = { threads: page.threads, sideThreads: page.sideThreads, nextPageToken: page.nextPageToken };
        threads.push(...page.threads);
        sideThreads.push(...page.sideThreads);
        pageToken = page.nextPageToken;

        if (!pageToken || i === pages - 1) {
          this.#first = first;
          this.#fresh = true;
          this.#set({
            threads: unique(threads),
            sideThreads: unique(sideThreads),
            totalCount: page.totalCount,
            nextPageToken: pageToken,
            loaded: true,
            loading: false,
          });
          this.remember?.(this.#filter, this.state);

          return;
        }
      }
    } catch (cause) {
      if (epoch === this.#epoch) this.#set({ loading: false, error: quiet ? this.state.error : message(cause) });
    }
  }

  #current(epoch: number, revision: number | undefined) {
    if (epoch !== this.#epoch) return false;

    if (revision !== this.revision?.()) {
      this.#set({ loading: false });

      return false;
    }

    return true;
  }
}

const unique = (threads: ui.Thread[]) => [...new Map(threads.map((t) => [t.id, t])).values()];
const message = (cause: unknown) => (cause instanceof Error ? cause.message : "Could not load archived threads.");
