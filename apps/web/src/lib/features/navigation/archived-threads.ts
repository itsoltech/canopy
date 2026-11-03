import type { ui } from "@canopy/contracts";

export interface ArchivedFilter { projectIds: string[]; query: string }
export interface ArchivedPageState {
  threads: ui.Thread[];
  sideThreads: ui.Thread[];
  totalCount: number | undefined;
  nextPageToken: string;
  loading: boolean;
  error: string;
}
type Load = (request: ArchivedFilter & { pageToken: string; countOnly: boolean }) => Promise<ui.ListArchivedThreadsResponse>;
const empty = (): ArchivedPageState => ({ threads: [], sideThreads: [], totalCount: undefined, nextPageToken: "", loading: false, error: "" });

/** Latest request wins. Live invalidations rebuild the loaded pages using fresh keyset cursors;
 * a collapsed section fetches only its count, and never downloads the archive in the overview. */
export class ArchivedThreadsPager {
  state = empty();
  #epoch = 0;
  #pages = 1;
  #key = "";
  #expanded = false;
  #filter: ArchivedFilter = { projectIds: [], query: "" };
  constructor(private load: Load, private changed: (state: ArchivedPageState) => void) {}
  #set(change: Partial<ArchivedPageState>) { this.state = { ...this.state, ...change }; this.changed(this.state); }

  async refresh(filter: ArchivedFilter, expanded: boolean): Promise<void> {
    const key = JSON.stringify([[...filter.projectIds].sort(), filter.query.trim().toLowerCase()]);
    if (key !== this.#key) { this.#key = key; this.#pages = 1; this.state = empty(); }
    if (expanded !== this.#expanded) this.#pages = 1;
    this.#filter = filter;
    this.#expanded = expanded;
    const epoch = ++this.#epoch;
    this.#set({ loading: true, error: "" });
    try {
      let threads: ui.Thread[] = [];
      let sideThreads: ui.Thread[] = [];
      let pageToken = "";
      for (let i = 0; i < (expanded ? this.#pages : 1); i++) {
        const page = await this.load({ ...filter, pageToken, countOnly: !expanded });
        if (epoch !== this.#epoch) return;
        threads = [...threads, ...page.threads];
        sideThreads = [...sideThreads, ...page.sideThreads];
        pageToken = page.nextPageToken;
        if (!pageToken || i === this.#pages - 1 || !expanded) {
          this.#set({ threads: unique(threads), sideThreads: unique(sideThreads), totalCount: page.totalCount, nextPageToken: pageToken, loading: false });
          return;
        }
      }
    } catch (cause) { if (epoch === this.#epoch) this.#set({ loading: false, error: message(cause) }); }
  }

  async more(): Promise<void> {
    if (!this.#expanded || this.state.loading || !this.state.nextPageToken) return;
    const epoch = ++this.#epoch;
    this.#set({ loading: true, error: "" });
    try {
      const page = await this.load({ ...this.#filter, pageToken: this.state.nextPageToken, countOnly: false });
      if (epoch !== this.#epoch) return;
      this.#pages += 1;
      this.#set({ threads: unique([...this.state.threads, ...page.threads]), sideThreads: unique([...this.state.sideThreads, ...page.sideThreads]), totalCount: page.totalCount, nextPageToken: page.nextPageToken, loading: false });
    } catch (cause) { if (epoch === this.#epoch) this.#set({ loading: false, error: message(cause) }); }
  }

  dispose() { this.#epoch += 1; }
}
const unique = (threads: ui.Thread[]) => [...new Map(threads.map((t) => [t.id, t])).values()];
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Could not load archived threads.";
