import { getContext, setContext } from "svelte";
import { ui } from "@open-agents/contracts";
import { decode } from "#lib/shared/wire.ts";

/**
 * Workers, projects and thread statuses for the whole app, kept live by the overview SSE stream.
 * Shared with pages through context (one subscription per tab).
 */
export class OverviewState {
  workers = $state.raw<ui.Worker[]>([]);
  projects = $state.raw<ui.Project[]>([]);
  /** Latest known state of threads seen in this tab (status changes arrive live). */
  threads = $state.raw<ReadonlyMap<string, ui.Thread>>(new Map());

  constructor(initial: ui.GetOverviewResponse) {
    this.workers = initial.workers;
    this.projects = initial.projects;
  }

  worker(id: string): ui.Worker | undefined {
    return this.workers.find((w) => w.id === id);
  }

  apply(update: ui.OverviewUpdate): void {
    const change = update.change;
    if (change.case === "worker") this.workers = upsert(this.workers, change.value, (w) => w.id);
    if (change.case === "project") this.projects = upsert(this.projects, change.value, (p) => p.id);
    if (change.case === "thread") this.threads = new Map(this.threads).set(change.value.id, change.value);
  }

  connect(): () => void {
    const source = new EventSource("/api/overview/events");
    source.onmessage = (message) => this.apply(decode(ui.OverviewUpdateSchema, JSON.parse(message.data)));
    return () => source.close();
  }
}

function upsert<T>(list: readonly T[], value: T, key: (v: T) => string): T[] {
  const index = list.findIndex((item) => key(item) === key(value));
  return index >= 0 ? list.with(index, value) : [...list, value];
}

const KEY = Symbol("overview");
export const provideOverview = (state: OverviewState) => setContext(KEY, state);
export const useOverview = () => getContext<OverviewState>(KEY);
