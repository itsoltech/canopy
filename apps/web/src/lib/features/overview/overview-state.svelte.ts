import { getContext, setContext } from "svelte";
import { ui } from "@open-agents/contracts";
import { decode } from "#lib/shared/wire.ts";
import { liveSource } from "#lib/shared/live-source.ts";

/** live: stream open and in sync; reconnecting: dropped, retrying; unavailable: the gateway does not answer. */
export type OverviewConnection = "live" | "reconnecting" | "unavailable";

/**
 * Workers, projects and every thread for the whole app, kept live by the overview SSE stream.
 * Shared with pages through context (one subscription per tab). The stream carries changes only,
 * so every reconnect reloads the full overview and thread index to pick up what happened in between.
 */
export class OverviewState {
  workers = $state.raw<ui.Worker[]>([]);
  projects = $state.raw<ui.Project[]>([]);
  /** Every thread by id (seeded from the server, status changes and new threads arrive live). */
  threads = $state.raw<ReadonlyMap<string, ui.Thread>>(new Map());
  connection = $state<OverviewConnection>("live");
  /** Grows with every reload after a gap in the stream: state kept elsewhere (settings, schedules) reloads too. */
  resyncs = $state(0);
  #synced = false;
  #listeners = new Set<(update: ui.OverviewUpdate) => void>();

  constructor(initial: ui.GetOverviewResponse | undefined, threads: readonly ui.Thread[] = []) {
    if (initial) this.#replace(initial, threads);
    else this.connection = "unavailable";
  }

  worker(id: string): ui.Worker | undefined {
    return this.workers.find((w) => w.id === id);
  }

  project(id: string): ui.Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** A project's threads with live changes laid over them, plus threads created since `list` was loaded. */
  liveThreads(projectId: string, list: readonly ui.Thread[]): ui.Thread[] {
    const known = new Set(list.map((t) => t.id));
    const added = [...this.threads.values()].filter((t) => t.projectId === projectId && !known.has(t.id));
    return [...list.map((t) => this.threads.get(t.id) ?? t), ...added];
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
    if (change.case === "project") this.projects = upsert(this.projects, change.value, (p) => p.id);
    if (change.case === "thread") this.threads = new Map(this.threads).set(change.value.id, change.value);
  }

  #replace(overview: ui.GetOverviewResponse, threads: readonly ui.Thread[]): void {
    this.workers = overview.workers;
    this.projects = overview.projects;
    this.threads = new Map(threads.map((t) => [t.id, t]));
    this.#synced = true;
  }

  async #resync(): Promise<void> {
    const get = async (path: string) => {
      const response = await fetch(path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    try {
      const [overview, threads] = await Promise.all([get("/api/overview"), get("/api/threads")]);
      this.#replace(decode(ui.GetOverviewResponseSchema, overview), decode(ui.ListThreadsResponseSchema, threads).threads);
      this.connection = "live";
      this.resyncs += 1;
    } catch {
      this.connection = "unavailable";
    }
  }

  connect(): () => void {
    return liveSource("/api/overview/events", {
      // The server-rendered overview is fresh on the first open; later opens follow a gap.
      onopen: (reconnected) => {
        if (!reconnected && this.#synced) this.connection = "live";
        else void this.#resync();
      },
      ondrop: () => {
        if (this.connection === "live") this.connection = "reconnecting";
      },
      onfailure: () => (this.connection = "unavailable"),
      onmessage: (data) => this.apply(decode(ui.OverviewUpdateSchema, JSON.parse(data))),
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
