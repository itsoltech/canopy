import { getContext, setContext } from "svelte";
import { ui } from "@open-agents/contracts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { threadModelOptions, type ModelOption } from "./catalog.ts";

/**
 * The model catalog of every worker (`ListModels`): per provider and profile the models it offers, as the
 * worker last reported them. Loaded through the BFF, kept current by `OverviewUpdate.models` (sent after
 * every config change and refresh) and reloaded after a gap in the stream. `refresh` asks a worker again.
 */
export class ModelCatalogState {
  /** Catalog by worker id. */
  workers = $state.raw<ReadonlyMap<string, ui.WorkerModels>>(new Map());
  /** Workers whose list is being read again. */
  refreshing = $state.raw<ReadonlySet<string>>(new Set());
  /** Why the last refresh of a worker failed (cleared by the next one). */
  errors = $state.raw<ReadonlyMap<string, string>>(new Map());

  constructor(initial: ui.ListModelsResponse | undefined) {
    if (initial) this.#replace(initial);
  }

  of(workerId: string): ui.WorkerModels | undefined {
    return this.workers.get(workerId);
  }

  apply(update: ui.OverviewUpdate): void {
    if (update.change.case === "models") this.#set(update.change.value);
  }

  async reload(): Promise<void> {
    this.#replace(decode(ui.ListModelsResponseSchema, await requestJson("GET", "/api/models")));
  }

  /** Lists the worker's models again (it must be online); the result also arrives through the stream. */
  async refresh(workerId: string): Promise<void> {
    if (this.refreshing.has(workerId)) return;
    this.refreshing = new Set(this.refreshing).add(workerId);
    this.errors = without(this.errors, workerId);
    try {
      // The gateway waits for the worker (up to 90 s).
      const response = decode(ui.ListModelsResponseSchema, await requestJson("POST", "/api/models", { workerId }, 100_000));
      for (const worker of response.workers) this.#set(worker);
    } catch (cause) {
      this.errors = new Map(this.errors).set(workerId, cause instanceof Error ? cause.message : "Could not refresh the models");
    } finally {
      const next = new Set(this.refreshing);
      next.delete(workerId);
      this.refreshing = next;
    }
  }

  #set(worker: ui.WorkerModels): void {
    this.workers = new Map(this.workers).set(worker.workerId, worker);
  }

  #replace(response: ui.ListModelsResponse): void {
    this.workers = new Map(response.workers.map((w) => [w.workerId, w]));
  }
}

function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

const KEY = Symbol("model-catalog");
export const provideModelCatalog = (state: ModelCatalogState) => setContext(KEY, state);
export const useModelCatalog = () => getContext<ModelCatalogState>(KEY);

/**
 * A thread's model options (its provider and profile) and its default model as an option, kept current
 * with the catalog and the thread. Call during component setup.
 */
export function useThreadModels(source: () => { thread: ui.Thread; worker: ui.Worker | undefined }): { readonly options: ModelOption[]; readonly current: ModelOption | undefined } {
  const overview = useOverview();
  const catalog = useModelCatalog();
  const offer = $derived.by(() => {
    const { thread, worker } = source();
    return threadModelOptions(thread, { worker, catalog: catalog.of(thread.workerId), threads: overview.threads.values() });
  });
  return {
    get options() {
      return offer.options;
    },
    get current() {
      return offer.current;
    },
  };
}
