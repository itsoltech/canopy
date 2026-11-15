import { create, equals } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { QueryCache } from "./shared-query.ts";

type Change = NonNullable<ui.OverviewUpdate["change"]["case"]>;

type ManagedKey = (key: string) => boolean;

/** Shared reads (by request name) that an overview update makes stale. Keys are `Method` or `Method:scope`. */
const STALE: Partial<Record<Change, readonly string[]>> = {
  workerRecordsChanged: ["ListWorkerRecords"],
  // Names, presence and sharing decide which linked workers can be edited.
  computer: ["ListWorkerRecords", "GetComputers", "GetThreadPanel"],
  computerRemoved: ["ListWorkerRecords", "GetComputers", "GetThreadPanel"],
  sharedConfig: ["GetComputers", "GetThreadPanel"],
  agentEnvironmentChanged: ["GetAgentEnvironment", "GetWorkerEnvironment", "ListMentionCatalog", "GetThreadPanel"],
  workerRemoved: ["GetAgentEnvironment", "GetThreadPanel"],
  providerInstancesChanged: ["ListProviderInstances", "GetBotProviderInstances"],
  enrollment: ["GetWorkerSetup"],
  mobileDevice: ["GetMobileDevices"],
  mobilePairing: ["GetMobileDevices"],
  schedule: ["ListSchedules", "GetThreadPanel"],
  // A worker's new model list: settings that show catalogs read once; pickers apply the pushed list.
  models: ["ListModels"],
  connectorsChanged: ["ListConnectors", "GetThreadPanel"],
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
  readonly #computers = new Map<string, ui.LinkedComputer>();

  constructor(
    private readonly queries: QueryCache,
    private readonly managed: ManagedKey = () => false,
  ) {}

  #invalidate(match: (key: string) => boolean): void {
    this.queries.invalidate((key) => !this.managed(key) && match(key));
  }

  apply(update: ui.OverviewUpdate): void {
    const change = update.change;

    if (change.case === "computer") {
      // Mirror commits and heartbeats repeat presence. Freshness alone does not change settings.
      const current = { ...change.value, lastSeenMs: 0n };
      const previous = this.#computers.get(current.nodeId);
      this.#computers.set(current.nodeId, current);

      if (previous && equals(ui.LinkedComputerSchema, previous, current)) return;
    }

    if (change.case === "computerRemoved") this.#computers.delete(change.value);

    if (change.case === "thread") {
      const thread = change.value;
      const previous = this.#pullRequests.get(thread.id);
      this.#pullRequests.set(thread.id, thread.pullRequestRevision);

      // Revision zero is the normal projection for a thread without PR links. A first event for it is not a PR
      // change, and a full overview seeds known revisions before live events arrive.
      if (thread.pullRequestRevision !== 0n && previous !== thread.pullRequestRevision) {
        this.#invalidate(named([`ListThreadPullRequests:${thread.id}`]));

        // The thread projection carries only its newest PR. Keep this conservative so an older linked PR whose
        // metadata changed remains fresh too; the list read is still scoped to the changed thread.
        this.#invalidate(named(["GetPullRequest"]));
      }
    }

    if (["computerRemoved", "computerSnapshot", "mobileSnapshot"].includes(change.case ?? ""))
      this.queries.forget(
        (key) =>
          (change.case !== "mobileSnapshot" || !this.managed(key)) &&
          named(["GetPullRequest", "ListThreadPullRequests"])(key),
      );

    if (change.case === "linkedReadCompleted") {
      this.#invalidate(named([change.value]));

      return;
    }

    if (change.case === "worker") {
      const signature = workerSignature(change.value);
      const previous = this.#workers.get(change.value.id);
      this.#workers.set(change.value.id, signature);

      if (previous !== undefined && previous !== signature)
        this.#invalidate(named(["GetAgentEnvironment", "GetThreadPanel"]));

      return;
    }

    if (change.case === "proxyAccounts") {
      this.#proxyAccounts(change.value);

      return;
    }

    if (change.case === "workerRemoved") this.#workers.delete(change.value);
    const stale = change.case ? STALE[change.case] : undefined;

    if (stale) this.#invalidate(named(stale));
  }

  /** One proxy's upstream accounts, applied to the loaded proxy list in place: no read of the whole list. */
  #proxyAccounts(accounts: ui.ProxyAccounts): void {
    const list = this.queries.snapshot<ui.ListProxiesResponse>("ListProxies").data;

    if (!list?.proxies.some((p) => p.id === accounts.proxyId)) return;
    this.queries.set<ui.ListProxiesResponse>("ListProxies", (current) =>
      create(ui.ListProxiesResponseSchema, {
        proxies: (current?.proxies ?? []).map((p) =>
          p.id === accounts.proxyId ? create(ui.ProxySchema, { ...p, accounts }) : p,
        ),
      }),
    );
  }

  /** A full overview arrived. Seed revisions before live events; after a gap every shared read is stale once. */
  synced(workers: readonly ui.Worker[], threads: Iterable<ui.Thread>, gap: boolean): void {
    this.#workers.clear();
    this.#pullRequests.clear();
    this.#computers.clear();

    for (const worker of workers) this.#workers.set(worker.id, workerSignature(worker));

    for (const thread of threads) this.#pullRequests.set(thread.id, thread.pullRequestRevision);

    if (gap) this.#invalidate(() => true);
  }
}
