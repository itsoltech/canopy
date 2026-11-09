import { getContext, setContext } from "svelte";
import { ui } from "@canopy/contracts";
import { decode } from "#lib/shared/wire.ts";
import { ComputerAway, liveSource } from "#lib/shared/live-source.ts";
import { bodyJson, isJsonObject } from "#lib/shared/json.ts";
import { computerName } from "@canopy/domain/computer-presence";
import {
  retainProjects,
  retainLinkedRows,
  forgetComputerProjects,
  replaceComputerProjects,
  replaceComputerRows,
  workersWithAvailability,
  projectAwayReason,
} from "@canopy/domain/linked-snapshot";
import { projectChoices } from "@canopy/domain/projects";

/** live: stream open and in sync; reconnecting: dropped, retrying; unavailable: the gateway does not answer. */
export type OverviewConnection = "live" | "reconnecting" | "unavailable";

/**
 * Workers, projects and the active thread index, kept live by the overview SSE stream.
 * Shared with pages through context (one subscription per tab). The stream carries changes only,
 * so every reconnect reloads the full overview and thread index to pick up what happened in between.
 */
export class OverviewState {
  #workers = $state.raw<ui.Worker[]>([]);
  projects = $state.raw<ui.Project[]>([]);
  projectChoices = $derived(projectChoices(this.projects));
  /** Active threads and Previous agents, plus archived rows observed live or fetched on demand. */
  threads = $state.raw<ReadonlyMap<string, ui.Thread>>(new Map());
  /** Linked computers by node id. Mirror-capable peers remain listed while offline. */
  computers = $state.raw<ReadonlyMap<string, ui.LinkedComputer>>(new Map());
  workers = $derived(workersWithAvailability(this.#workers, [...this.computers.values()]));
  /** This computer's own: settings, schedules and workspaces are configured per computer. */
  ownWorkers = $derived(this.workers.filter((w) => !w.nodeId));
  ownProjects = $derived(this.projects.filter((p) => !p.nodeId));
  #deleted = new Set<string>();
  connection = $state<OverviewConnection>("reconnecting");
  /**
   * Domains the open stream pushes completely (`OverviewUpdate.feeds`): their readers stop polling. Empty while
   * the stream is down or the gateway is older.
   */
  pushed = $state.raw<ReadonlySet<string>>(new Set());
  /**
   * Grows with the first sync and every reload after a gap in the stream: state kept elsewhere (settings,
   * schedules, shared reads) reloads too. A background linked read that settles is not a gap.
   */
  resyncs = $state(0);
  #synced = false;
  #refreshing = false;
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

  projectChoice(id: string) {
    return this.projectChoices.find((project) => project.projectIds.includes(id));
  }

  projectAway(project: ui.Project) {
    return projectAwayReason(project, this.workers, [...this.computers.values()]);
  }

  computer(nodeId: string): ui.LinkedComputer | undefined {
    return nodeId ? this.computers.get(nodeId) : undefined;
  }

  /** The name of the linked computer something lives on; undefined for this computer's own. */
  machine(nodeId: string): string | undefined {
    return nodeId ? computerName(this.computer(nodeId)) : undefined;
  }

  /** Cache just the archive pages the user loaded; keep newer stream values over an HTTP snapshot. */
  remember(threads: readonly ui.Thread[], before: ReadonlyMap<string, ui.Thread>): void {
    if (!threads.length) return;
    const next = new Map(this.threads);

    for (const thread of threads) {
      if (this.#deleted.has(thread.id) || thread.deletedAt || this.threads.get(thread.id) !== before.get(thread.id))
        continue;
      next.set(thread.id, thread);
    }

    this.threads = next;
  }

  /** A loaded archive row follows lifecycle events immediately, before the next paged refresh. */
  liveThread(thread: ui.Thread): ui.Thread | undefined {
    return this.#deleted.has(thread.id) ? undefined : (this.threads.get(thread.id) ?? thread);
  }

  /** Other changes of the stream (settings, schedules) for whoever keeps that state; returns the unsubscribe. */
  subscribe(listener: (update: ui.OverviewUpdate) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  apply(update: ui.OverviewUpdate): void {
    for (const listener of this.#listeners) listener(update);
    const change = update.change;

    if (change.case === "feeds") this.pushed = new Set(change.value.pushed);

    if (
      change.case === "linkedReadCompleted" &&
      ["GetOverview", "ListThreads"].includes(change.value) &&
      !this.#refreshing
    ) {
      this.#refreshing = true;
      void this.#resync(AbortSignal.timeout(12_000), false)
        .catch(() => {})
        .finally(() => {
          this.#refreshing = false;
        });
    }

    if (change.case === "computerSnapshot") {
      const { nodeId, overview, threads } = change.value;
      const visible = new Set(threads.map((t) => t.id));

      for (const thread of this.threads.values()) {
        if (thread.nodeId === nodeId && thread.status !== "archived" && !visible.has(thread.id))
          this.#deleted.add(thread.id);
      }

      this.#workers = replaceComputerRows(this.#workers, overview?.workers ?? [], nodeId);
      this.projects = replaceComputerProjects(this.projects, overview?.projects ?? [], nodeId);
      this.threads = new Map([...this.threads].filter(([, thread]) => thread.nodeId !== nodeId));
      const next = new Map(this.threads);

      for (const thread of threads)
        if (!thread.deletedAt) {
          this.#deleted.delete(thread.id);
          next.set(thread.id, thread);
        }

      this.threads = next;
    }

    if (change.case === "worker") this.#workers = upsert(this.#workers, change.value, (w) => w.id);

    if (change.case === "workerRemoved") this.#workers = this.#workers.filter((w) => w.id !== change.value);

    if (change.case === "project")
      this.projects = change.value.archivedAt
        ? this.projects.filter((p) => p.id !== change.value.id)
        : upsert(this.projects, change.value, (p) => p.id);

    if (change.case === "computer") {
      this.computers = new Map(this.computers).set(change.value.nodeId, change.value);
    }

    if (change.case === "computerRemoved") {
      const next = new Map(this.computers);
      next.delete(change.value);
      this.computers = next;
      this.#forget(change.value);
    }

    if (change.case === "thread") {
      const next = new Map(this.threads);

      if (change.value.deletedAt) {
        this.#deleted.add(change.value.id);
        next.delete(change.value.id);
      } else {
        this.#deleted.delete(change.value.id);
        next.set(change.value.id, change.value);
      }

      this.threads = next;
    }
  }

  /** An authoritative home snapshot or unlink replaces that home's rows. */
  #forget(nodeId: string): void {
    this.#workers = this.#workers.filter((w) => w.nodeId !== nodeId);
    this.projects = forgetComputerProjects(this.projects, nodeId);
    this.threads = new Map([...this.threads].filter(([, t]) => t.nodeId !== nodeId));
  }

  #replace(overview: ui.GetOverviewResponse, threads: readonly ui.Thread[]): void {
    this.computers = new Map(overview.computers.map((c) => [c.nodeId, c]));
    this.#workers = retainLinkedRows(this.#workers, overview.workers, overview.computers);
    this.projects = retainProjects(this.projects, overview.projects, overview.computers);
    const retained = retainLinkedRows([...this.threads.values()], threads, overview.computers);
    const visible = new Map(retained.flatMap((t) => (t.deletedAt ? [] : [[t.id, t] as const])));

    // Reconcile deletions and restores that happened while the overview stream was disconnected.
    for (const [id, thread] of this.threads)
      if (!visible.has(id) && thread.status !== "archived") this.#deleted.add(id);

    for (const id of visible.keys()) this.#deleted.delete(id);
    this.threads = visible;
    this.#synced = true;
  }

  /** `gap`: the stream reconnected, so state kept elsewhere reads again (`resyncs`); a peer refresh does not. */
  async #resync(signal: AbortSignal, gap = true): Promise<void> {
    const get = async (path: string) => {
      const response = await fetch(path, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      });

      if (!response.ok) {
        const failure = await bodyJson(response).catch(() => null);

        if (isJsonObject(failure) && failure["scope"] === "computer") throw new ComputerAway();
        throw new Error(`HTTP ${response.status}`);
      }

      return response.json();
    };

    try {
      const [overview, threads] = await Promise.all([get("/api/overview"), get("/api/threads")]);

      if (signal.aborted) return;
      this.#replace(
        decode(ui.GetOverviewResponseSchema, overview),
        decode(ui.ListThreadsResponseSchema, threads).threads,
      );
      this.connection = "live";

      if (gap) this.resyncs += 1;
    } catch (cause) {
      if (signal.aborted) return;
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
        this.pushed = new Set();

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
