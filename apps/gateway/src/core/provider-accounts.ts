import { Provider, ui, type ProviderAccountStatus, type ProviderAccountsReport } from "@canopy/contracts";
import { sanitizeAccountStatus } from "@canopy/domain/provider-accounts";
import type { WorkerConnection } from "../worker-link/index.ts";
import type { GatewayCore } from "./core.ts";
import { coreProvidersChanged } from "./core-providers.ts";
import { coreBroadcastWorkers, coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";

interface Report {
  connection: WorkerConnection;
  version: bigint;
  accounts: Map<string, ProviderAccountStatus>;
}

interface Flight {
  refresh: boolean;
  task: Promise<boolean>;
}

/** Volatile display metadata: never a database row, outbox entry or log message. */
export class ProviderAccounts {
  readonly #reports = new Map<string, Report>();
  readonly #flights = new Map<WorkerConnection, Map<string, Flight>>();

  constructor(readonly core: GatewayCore) {}

  connected(connection: WorkerConnection): void {
    this.#reports.delete(connection.workerId);

    const timer = connection.hello.capabilities.includes("provider_account_status")
      ? setInterval(() => {
          const report = this.#reports.get(connection.workerId);

          if (report?.connection === connection) void this.refresh(connection, report.version);
        }, 15 * 60_000)
      : undefined;

    timer?.unref();
    void connection.closed.then(() => {
      clearInterval(timer);

      if (this.#reports.get(connection.workerId)?.connection === connection) this.#reports.delete(connection.workerId);
      this.#flights.delete(connection);
    });
  }

  get(workerId: string, provider: Provider, id: string, version?: bigint): ProviderAccountStatus | undefined {
    const report = this.#reports.get(workerId);

    if (!report || (version !== undefined && report.version !== version)) return undefined;

    if (this.core.link.connections.get(workerId) !== report.connection) return undefined;
    const value = report.accounts.get(`${provider}/${id}`);

    return value ? sanitizeAccountStatus(value) : undefined;
  }

  decorate(instances: ui.ProviderInstance[]): ui.ProviderInstance[] {
    for (const instance of instances)
      for (const worker of instance.workers) {
        worker.account =
          worker.enabled && worker.synced ? this.get(worker.workerId, instance.harness, instance.id) : undefined;
      }

    return instances;
  }

  refresh(
    connection: WorkerConnection,
    version: bigint,
    refresh = false,
    provider = Provider.UNSPECIFIED,
    id = "",
  ): Promise<boolean> {
    if (!connection.isOpen || !connection.hello.capabilities.includes("provider_account_status"))
      return Promise.resolve(false);
    let flights = this.#flights.get(connection);

    if (!flights) {
      flights = new Map();
      this.#flights.set(connection, flights);
    }

    const key = `${version}/${provider}/${id}`;
    const existing = flights.get(key);

    if (existing && (!refresh || existing.refresh)) return existing.task;

    // A forced refresh cannot reuse a cached read, even while that read is only broadcasting its result.
    // Queue it after the older read so the older report cannot overwrite the fresh one.
    const task: Promise<boolean> = (existing?.task ?? Promise.resolve())
      .then(() => coreRun(this.core, (s) => s.listWorkers(this.core.online, this.core[coreState].options.userId)))
      .then((workers) =>
        workers.some((w) => w.id === connection.workerId)
          ? connection.sendCommand(
              { case: "getProviderAccounts", value: { configVersion: version, refresh, provider, profileId: id } },
              60_000,
            )
          : undefined,
      )
      .then(async (result) => {
        if (
          !result?.ok ||
          !result.providerAccounts ||
          result.providerAccounts.configVersion !== version ||
          this.core.link.connections.get(connection.workerId) !== connection ||
          !connection.isOpen
        )
          return false;
        // A newer ConfigApplied may have arrived while a CLI was still running.
        const prior = this.#reports.get(connection.workerId);

        if (prior && prior.version > version) return false;
        this.#save(connection, result.providerAccounts, provider, id);
        coreProvidersChanged(this.core);
        await coreBroadcastWorkers(this.core);

        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (flights.get(key)?.task === task) flights.delete(key);
      });

    flights.set(key, { refresh, task });

    return task;
  }

  applied(connection: WorkerConnection, version: bigint): void {
    const prior = this.#reports.get(connection.workerId);

    if (!prior || prior.version !== version)
      this.#reports.set(connection.workerId, { connection, version, accounts: new Map() });
    void this.refresh(connection, version);
  }

  #save(connection: WorkerConnection, report: ProviderAccountsReport, provider: Provider, id: string): void {
    const prior = this.#reports.get(connection.workerId);

    const accounts =
      provider && id && prior?.version === report.configVersion
        ? new Map(prior.accounts)
        : new Map<string, ProviderAccountStatus>();

    for (const entry of report.entries.slice(0, 256)) {
      if (
        !entry.account ||
        ![Provider.CLAUDE, Provider.CODEX, Provider.GROK].includes(entry.provider) ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(entry.profileId) ||
        (provider && entry.provider !== provider) ||
        (id && entry.profileId !== id)
      )
        continue;
      accounts.set(`${entry.provider}/${entry.profileId}`, sanitizeAccountStatus(entry.account));
    }

    this.#reports.set(connection.workerId, { connection, version: report.configVersion, accounts });
  }
}
