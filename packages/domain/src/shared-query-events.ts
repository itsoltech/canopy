import type { ui } from "@canopy/contracts";
import type { QueryCache } from "./shared-query.ts";

type Change = NonNullable<ui.OverviewUpdate["change"]["case"]>;

/** Shared reads (by request name) that an overview update makes stale. Keys are `Method` or `Method:scope`. */
const STALE: Partial<Record<Change, readonly string[]>> = {
  workerRecordsChanged: ["ListWorkerRecords"],
  // Names, presence and sharing decide which linked workers can be edited.
  computer: ["ListWorkerRecords", "GetComputers"],
  computerRemoved: ["ListWorkerRecords", "GetComputers"],
  sharedConfig: ["GetComputers"],
  agentEnvironmentChanged: ["GetAgentEnvironment", "GetWorkerEnvironment", "ListMentionCatalog"],
  workerRemoved: ["GetAgentEnvironment"],
  providerInstancesChanged: ["ListProviderInstances", "GetBotProviderInstances"],
  enrollment: ["GetWorkerSetup"],
  mobileDevice: ["GetMobileDevices"],
  mobilePairing: ["GetMobileDevices"],
  schedule: ["ListSchedules"],
  // A worker's new model list: settings that show catalogs read once; pickers apply the pushed list.
  models: ["ListModels"],
  connectorsChanged: ["ListConnectors"],
  proxiesChanged: ["ListProxies"],
};

/** A key names one request (`Method`, `Method:scope`) or several joined by `+`; any of them matches. */
const named = (prefixes: readonly string[]) => (key: string) =>
  key.split("+").some((part) => prefixes.some((prefix) => part === prefix || part.startsWith(`${prefix}:`)));

/**
 * What a worker's report changes for shared reads: its environment status and presence. A broadcast that
 * repeats every worker unchanged changes nothing.
 */
const workerSignature = (worker: ui.Worker) =>
  `${worker.online}:${worker.configVersion}:${worker.appliedVersion}:${worker.version}`;

/** Applies overview updates to one session's shared reads. One instance per session. */
export class OverviewInvalidation {
  readonly #workers = new Map<string, string>();
  readonly #pullRequests = new Map<string, bigint>();

  constructor(private readonly queries: QueryCache) {}

  apply(update: ui.OverviewUpdate): void {
    const change = update.change;

    if (change.case === "thread") {
      const thread = change.value;
      const previous = this.#pullRequests.get(thread.id);
      this.#pullRequests.set(thread.id, thread.pullRequestRevision);

      if (previous !== thread.pullRequestRevision)
        this.queries.forget(named(["GetPullRequest", "ListThreadPullRequests"]));
    }

    if (["computerRemoved", "computerSnapshot", "mobileSnapshot"].includes(change.case ?? ""))
      this.queries.forget(named(["GetPullRequest", "ListThreadPullRequests"]));

    if (change.case === "linkedReadCompleted") {
      this.queries.invalidate(named([change.value]));

      return;
    }

    if (change.case === "worker") {
      const signature = workerSignature(change.value);
      const previous = this.#workers.get(change.value.id);
      this.#workers.set(change.value.id, signature);

      if (previous !== undefined && previous !== signature) this.queries.invalidate(named(["GetAgentEnvironment"]));

      return;
    }

    if (change.case === "workerRemoved") this.#workers.delete(change.value);
    const stale = change.case ? STALE[change.case] : undefined;

    if (stale) this.queries.invalidate(named(stale));
  }

  /** A full overview arrived. After a gap in the stream (`gap`) every shared read is stale once. */
  synced(workers: readonly ui.Worker[], gap: boolean): void {
    this.#workers.clear();

    for (const worker of workers) this.#workers.set(worker.id, workerSignature(worker));

    if (gap) {
      this.queries.forget(named(["GetPullRequest", "ListThreadPullRequests"]));
      this.queries.invalidate(() => true);
    }
  }
}
