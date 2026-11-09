import type { ProfileModels, ui } from "@canopy/contracts";
import type { mobileClient } from "../../api/client";

const empty: ProfileModels[] = [];

/**
 * One pairing's catalogs: synchronous reads for composers and shared requests while the list preloads them.
 * A worker's catalog is read once; afterwards the overview stream pushes its new lists (`models`). A gap in the
 * stream makes every catalog stale: the ones in use read again, the rest on next use.
 */
export class ModelCatalogCache {
  #profiles = new Map<string, ProfileModels[]>();
  #pending = new Map<string, Promise<void>>();
  #stale = new Set<string>();
  #watched = new Map<string, number>();
  #listeners = new Set<() => void>();

  constructor(readonly api: ReturnType<typeof mobileClient>["api"] | undefined) {}

  peek(workerId: string | undefined) {
    return workerId ? (this.#profiles.get(workerId) ?? empty) : empty;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };

  /** A pushed catalog replaces the stored one; a read in flight is older and is dropped. */
  apply(models: ui.WorkerModels) {
    this.#pending.delete(models.workerId);
    this.#stale.delete(models.workerId);
    this.#profiles.set(models.workerId, models.profiles);

    for (const listener of this.#listeners) listener();
  }

  /** Keeps the worker's catalog current while a composer or picker shows it; returns the release. */
  watch(workerId: string) {
    this.#watched.set(workerId, (this.#watched.get(workerId) ?? 0) + 1);

    return () => {
      const count = (this.#watched.get(workerId) ?? 1) - 1;

      if (count > 0) this.#watched.set(workerId, count);
      else this.#watched.delete(workerId);
    };
  }

  invalidate() {
    for (const workerId of this.#profiles.keys()) this.#stale.add(workerId);

    for (const workerId of this.#watched.keys()) void this.load(workerId).catch(() => {});
  }

  load(workerId: string): Promise<void> {
    if (!this.api) return Promise.resolve();

    const pending = this.#pending.get(workerId);

    if (pending) return pending;

    if (this.#profiles.has(workerId) && !this.#stale.has(workerId)) return Promise.resolve();
    this.#stale.delete(workerId);

    const request = this.api
      .listModels({ workerId }, { timeoutMs: 10_000 })
      .then((result) => {
        // A pushed catalog replaced this read meanwhile.
        if (this.#pending.get(workerId) !== request) return;
        this.#profiles.set(
          workerId,
          result.workers.flatMap((worker) => worker.profiles),
        );

        for (const listener of this.#listeners) listener();
      })
      .finally(() => {
        if (this.#pending.get(workerId) === request) this.#pending.delete(workerId);
      });

    this.#pending.set(workerId, request);

    return request;
  }
}
