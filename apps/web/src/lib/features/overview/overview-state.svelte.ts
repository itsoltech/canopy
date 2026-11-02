import { getContext, setContext } from "svelte";
import { ui } from "@open-agents/contracts";
import { decode } from "#lib/shared/wire.ts";
import { liveSource } from "#lib/shared/live-source.ts";

/** live: stream open and in sync; reconnecting: dropped, retrying; unavailable: the gateway does not answer. */
export type OverviewConnection = "live" | "reconnecting" | "unavailable";

/**
 * Workers, projects and the active thread index, kept live by the overview SSE stream.
 * Shared with pages through context (one subscription per tab). The stream carries changes only,
 * so every reconnect reloads the full overview and thread index to pick up what happened in between.
 */
export class OverviewState {
  workers = $state.raw<ui.Worker[]>([]);
  projects = $state.raw<ui.Project[]>([]);
  /** Active threads and Previous agents, plus archived rows observed live or fetched on demand. */
  threads = $state.raw<ReadonlyMap<string, ui.Thread>>(new Map());
  #deleted = new Set<string>();
  connection = $state<OverviewConnection>("reconnecting");
  /** Grows with every reload after a gap in the stream: state kept elsewhere (settings, schedules) reloads too. */
  resyncs = $state(0);
  #synced = false;
  #listeners = new Set<(update: ui.OverviewUpdate) => void>();

  constructor(initial: ui.GetOverviewResponse | undefined, threads: readonly ui.Thread[] = []) {
    if (initial) this.#replace(initial, threads);
  }

  worker(id: string): ui.Worker | undefined {
    return this.workers.find((w) => w.id === id);
  }

  project(id: string): ui.Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** Cache just the archive pages the user loaded; keep newer stream values over an HTTP snapshot. */
  remember(threads: readonly ui.Thread[], before: ReadonlyMap<string, ui.Thread>): void {
    if (!threads.length) return;
    const next = new Map(this.threads);
    for (const thread of threads) {
      if (this.#deleted.has(thread.id) || thread.deletedAt || this.threads.get(thread.id) !== before.get(thread.id)) continue;
      next.set(thread.id, thread);
    }
    this.threads = next;
  }

  /** A loaded archive row follows lifecycle events immediately, before the next paged refresh. */
  liveThread(thread: ui.Thread): ui.Thread | undefined {
    return this.#deleted.has(thread.id) ? undefined : this.threads.get(thread.id) ?? thread;
  }

  /** A project's threads with live changes laid over them, plus threads created since `list` was loaded. */
  liveThreads(projectId: string, list: readonly ui.Thread[]): ui.Thread[] {
    const known = new Set(list.map((t) => t.id));
    const added = [...this.threads.values()].filter((t) => t.projectId === projectId && !known.has(t.id));
    return [...list.map((t) => this.threads.get(t.id) ?? t), ...added].filter((t) => !this.#deleted.has(t.id) && !t.deletedAt);
  }

  /** Other changes of the stream (settings, schedules) for whoever keeps that state; returns the unsubscribe. */
  subscribe(listener: (update: ui.OverviewUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  apply(update: ui.OverviewUpdate): void {
    for (const listener of this.#listeners) listener(update);
    const change = update.change;
    if (change.case === "worker") this.workers = upsert(this.workers, change.value, (w) => w.id);
    if (change.case === "project") this.projects = change.value.archivedAt
      ? this.projects.filter((p) => p.id !== change.value.id)
      : upsert(this.projects, change.value, (p) => p.id);
    if (change.case === "thread") {
      const next = new Map(this.threads);
      if (change.value.deletedAt) { this.#deleted.add(change.value.id); next.delete(change.value.id); }
      else { this.#deleted.delete(change.value.id); next.set(change.value.id, change.value); }
      this.threads = next;
    }
  }

  #replace(overview: ui.GetOverviewResponse, threads: readonly ui.Thread[]): void {
    this.workers = overview.workers;
    this.projects = overview.projects;
    const visible = new Map(threads.filter((t) => !t.deletedAt).map((t) => [t.id, t]));
    // Reconcile deletions and restores that happened while the overview stream was disconnected.
    for (const [id, thread] of this.threads) if (!visible.has(id) && thread.status !== "archived") this.#deleted.add(id);
    for (const id of visible.keys()) this.#deleted.delete(id);
    this.threads = visible;
    this.#synced = true;
  }

  async #resync(signal: AbortSignal): Promise<void> {
    const get = async (path: string) => {
      const response = await fetch(path, { headers: { accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    try {
      const [overview, threads] = await Promise.all([get("/api/overview"), get("/api/threads")]);
      if (signal.aborted) return;
      this.#replace(decode(ui.GetOverviewResponseSchema, overview), decode(ui.ListThreadsResponseSchema, threads).threads);
      this.connection = "live";
      this.resyncs += 1;
    } catch (cause) {
      if (signal.aborted) return;
      this.connection = "unavailable";
      throw cause;
    }
  }

  connect(): () => void {
    let pending: ui.OverviewUpdate[] | undefined;
    return liveSource("/api/overview/events", {
      // A supplied seed is fresh on the first open; otherwise fetch it, and always resync after a gap.
      onopen: async (reconnected, signal) => {
        if (!reconnected && this.#synced) this.connection = "live";
        else {
          pending = [];
          await this.#resync(signal);
          if (signal.aborted) return;
          for (const update of pending) this.apply(update);
          pending = undefined;
        }
      },
      ondrop: () => {
        if (this.connection === "live") this.connection = "reconnecting";
      },
      onfailure: () => (this.connection = "unavailable"),
      onmessage: (data) => {
        const update = decode(ui.OverviewUpdateSchema, JSON.parse(data));
        if (pending) pending.push(update);
        else this.apply(update);
      },
    });
  }
}

function upsert<T>(list: readonly T[], value: T, key: (v: T) => string): T[] {
  const index = list.findIndex((item) => key(item) === key(value));
  return index >= 0 ? list.with(index, value) : [...list, value];
}

const KEY = Symbol("overview");
export const provideOverview = (state: OverviewState) => setContext(KEY, state);
export const useOverview = () => getContext<OverviewState>(KEY);
