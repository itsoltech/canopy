import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ArchivedFilter, ArchivedPageState } from "@canopy/domain/archived-threads";
import { isArchivedSidebarThread } from "@canopy/domain/sidebar-threads";
import type { ThreadCacheStorage } from "./thread-cache";
import { archiveKey, decodeArchive, encodeArchive } from "./archived-cache-codec";
import { mergeArchivedThread, mergeSavedPeers } from "./archived-rows";

const maxBytes = 8 * 1024 * 1024;
const maxFilters = 8;

type Entry = { filter: ArchivedFilter; state: ArchivedPageState; id: string };

/** Separate from transcript LRU: saved sidebar pages survive navigation, restart and gateway loss. */
export class PersistentArchivedCache {
  #entries = new Map<string, Entry>();
  #writing: Promise<void> = Promise.resolve();
  #closed = false;
  #nextId = 0;
  #dirty = new Set<string>();
  #pending: Promise<void> | undefined;
  #filtered = new Map<string, ArchivedPageState>();
  revision = 0;
  metadata = create(ui.GetOverviewResponseSchema);

  constructor(readonly storage: ThreadCacheStorage) {}

  async restore() {
    let bytes = 0;
    let metadataLoaded = false;

    for (const file of (await this.storage.list()).sort((a, b) => b.accessed - a.accessed)) {
      if (this.#closed) return;

      if (bytes + file.bytes > maxBytes || (file.id !== "metadata" && this.#entries.size >= maxFilters)) {
        await this.storage.remove(file.name);
        continue;
      }

      try {
        const data = await this.storage.read(file.name);

        if (this.#closed) return;

        if (file.id === "metadata") {
          if (metadataLoaded) {
            await this.storage.remove(file.name);
            continue;
          }

          this.metadata = fromBinary(ui.GetOverviewResponseSchema, data);
          metadataLoaded = true;
        } else {
          const { filter, state } = decodeArchive(data);
          const key = archiveKey(filter);
          this.#nextId = Math.max(this.#nextId, Number(file.id) || 0);

          if (!this.#entries.has(key)) this.#entries.set(key, { filter, state, id: file.id });
        }

        bytes += file.bytes;
      } catch {
        await this.storage.remove(file.name);
      }
    }

    this.#entries = new Map([...this.#entries].reverse());
  }

  peek(filter: ArchivedFilter) {
    if (this.#closed) return;
    const key = archiveKey(filter);
    const exact = this.#entries.get(key)?.state ?? this.#filtered.get(key);

    if (exact) return exact;
    const saved = this.#entries.get(archiveKey({ projectIds: [], query: "" }))?.state;

    if (!saved) return;
    const query = filter.query.trim().toLowerCase();

    const threads = saved.threads.filter((thread) => {
      if (filter.projectIds.length && !filter.projectIds.includes(thread.projectId)) return false;
      const project = this.metadata.projects.find((project) => project.id === thread.projectId)?.name ?? "";

      return !query || `${thread.title} ${project}`.toLowerCase().includes(query);
    });

    const roots = new Set(threads.map((thread) => thread.id));

    const state = {
      ...saved,
      threads,
      sideThreads: saved.sideThreads.filter((thread) => roots.has(thread.parentThreadId)),
      totalCount: undefined,
      nextPageToken: "",
      loaded: false,
    };

    if (this.#filtered.size >= maxFilters) this.#filtered.clear();
    this.#filtered.set(key, state);

    return state;
  }

  remember(filter: ArchivedFilter, state: ArchivedPageState) {
    if (this.#closed || !state.loaded || state.loading || state.error) return;
    const peers = state.threads.filter((thread) => !!thread.nodeId);

    if (peers.length)
      state = {
        ...state,
        threads: mergeSavedPeers(
          state.threads.filter((thread) => !thread.nodeId),
          peers,
        ),
      };
    const key = archiveKey(filter);
    const old = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, { filter, state, id: old?.id ?? String(++this.#nextId) });
    this.#filtered.clear();

    this.#dirty.add(key);

    return this.#persist();
  }

  /** The current gateway archive endpoint is local-only. Its pages cannot delete a peer's saved rows. */
  withSavedPeers(
    filter: ArchivedFilter & { pageToken: string; countOnly: boolean },
    page: ui.ListArchivedThreadsResponse,
  ) {
    const saved = this.peek(filter);
    const peers = saved?.threads.filter((thread) => !!thread.nodeId) ?? [];
    const ids = new Set(peers.map((thread) => thread.id));

    return create(ui.ListArchivedThreadsResponseSchema, {
      ...page,
      totalCount: page.totalCount + peers.length,
      threads: filter.countOnly || filter.pageToken ? page.threads : mergeSavedPeers(page.threads, peers),
      sideThreads:
        filter.countOnly || filter.pageToken
          ? page.sideThreads
          : [...page.sideThreads, ...(saved?.sideThreads.filter((thread) => ids.has(thread.parentThreadId)) ?? [])],
    });
  }

  rememberMetadata(projects: ui.Project[], workers: ui.Worker[]) {
    if (this.#closed) return;
    this.metadata = create(ui.GetOverviewResponseSchema, {
      projects: [...new Map([...this.metadata.projects, ...projects].map((row) => [row.id, row])).values()],
      workers: [...new Map([...this.metadata.workers, ...workers].map((row) => [row.id, row])).values()],
    });
    this.#filtered.clear();
    this.#dirty.add("metadata");

    return this.#persist();
  }

  /** Overview absence is not deletion: only explicit lifecycle events remove saved rows. */
  reconcile(thread: ui.Thread) {
    if (this.#closed) return;
    this.#filtered.clear();

    if (
      isArchivedSidebarThread(thread) &&
      !thread.parentThreadId &&
      !this.#entries.has(archiveKey({ projectIds: [], query: "" }))
    ) {
      const filter = { projectIds: [], query: "" };
      this.#entries.set(archiveKey(filter), {
        filter,
        id: String(++this.#nextId),
        state: {
          threads: [],
          sideThreads: [],
          totalCount: undefined,
          loaded: false,
          loading: false,
          error: "",
          nextPageToken: "",
        },
      });
    }

    for (const [key, entry] of this.#entries) {
      const state = mergeArchivedThread(entry.state, thread, entry.filter, this.metadata.projects);

      if (state === entry.state) continue;
      entry.state = state;
      this.revision++;
      this.#dirty.add(key);
    }

    return this.#dirty.size ? this.#persist() : undefined;
  }

  forgetComputer(nodeId: string) {
    if (this.#closed) return Promise.resolve();
    this.#filtered.clear();
    this.revision++;

    for (const [key, entry] of this.#entries) {
      const removed = entry.state.threads.filter((row) => row.nodeId === nodeId).length;
      entry.state = {
        ...entry.state,
        threads: entry.state.threads.filter((row) => row.nodeId !== nodeId),
        sideThreads: entry.state.sideThreads.filter((row) => row.nodeId !== nodeId),
        totalCount: entry.state.totalCount === undefined ? undefined : Math.max(0, entry.state.totalCount - removed),
      };
      this.#dirty.add(key);
    }

    return this.#persist();
  }

  close() {
    this.#closed = true;
    this.#entries.clear();
    this.#filtered.clear();
    this.revision++;
    this.#dirty.clear();
    this.metadata = create(ui.GetOverviewResponseSchema);

    return this.#serial(() => this.storage.clear());
  }

  #persist() {
    if (this.#pending) return this.#pending;

    const pending = this.#serial(async () => {
      if (this.#closed) return;
      const dirty = new Set(this.#dirty);
      this.#dirty.clear();
      const previous = await this.storage.list();
      const replaced = new Set<string>();

      for (const [index, [key, entry]] of [...this.#entries].reverse().entries()) {
        if (index >= maxFilters) {
          this.#entries.delete(key);
          replaced.add(entry.id);
          continue;
        }

        if (!dirty.has(key)) continue;
        const data = encodeArchive(entry.filter, entry.state);

        if (data.byteLength > maxBytes / maxFilters) this.#entries.delete(key);
        else await this.storage.write(entry.id, data);
        replaced.add(entry.id);
      }

      if (dirty.has("metadata")) {
        await this.storage.write("metadata", toBinary(ui.GetOverviewResponseSchema, this.metadata));
        replaced.add("metadata");
      }

      for (const file of previous) if (replaced.has(file.id)) await this.storage.remove(file.name);
    }).finally(async () => {
      this.#pending = undefined;

      if (!this.#closed && this.#dirty.size) await this.#persist();
    });

    this.#pending = pending;

    return pending;
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#writing.then(run, run);
    this.#writing = next.then(
      () => {},
      () => {},
    );

    return next;
  }
}
