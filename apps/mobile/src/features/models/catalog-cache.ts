import type { ProfileModels } from "@canopy/contracts";
import type { mobileClient } from "../../api/client";

const empty: ProfileModels[] = [];

/** One pairing's catalogs: synchronous reads for composers and shared requests while the list preloads them. */
export class ModelCatalogCache {
  #profiles = new Map<string, ProfileModels[]>();
  #pending = new Map<string, Promise<void>>();
  #listeners = new Set<() => void>();

  constructor(readonly api: ReturnType<typeof mobileClient>["api"] | undefined) {}

  peek(workerId: string | undefined) {
    return workerId ? (this.#profiles.get(workerId) ?? empty) : empty;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };

  load(workerId: string, refresh = false): Promise<void> {
    if (!this.api) return Promise.resolve();

    const pending = this.#pending.get(workerId);

    if (pending) return pending;

    if (!refresh && this.#profiles.has(workerId)) return Promise.resolve();

    const request = this.api
      .listModels({ workerId }, { timeoutMs: 10_000 })
      .then((result) => {
        this.#profiles.set(
          workerId,
          result.workers.flatMap((worker) => worker.profiles),
        );

        for (const listener of this.#listeners) listener();
      })
      .finally(() => this.#pending.delete(workerId));

    this.#pending.set(workerId, request);

    return request;
  }
}
