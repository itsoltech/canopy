import {
  Provider,
  ui,
  type LoginStarted,
  type ProviderAccountStatus,
  type ProviderAccountsReport,
} from "@canopy/contracts";
import { REJECTED_LOGIN_DETAIL, sanitizeAccountStatus } from "@canopy/domain/provider-accounts";
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

// Logins that sign in again; a rejected API key or proxy key is a settings problem, not an expired sign-in.
const signInMethods = new Set(["claude.ai", "Subscription account", "ChatGPT", "Account", ""]);

/** Volatile display metadata: never a database row, outbox entry or log message. */
export class ProviderAccounts {
  readonly #reports = new Map<string, Report>();
  readonly #flights = new Map<WorkerConnection, Map<string, Flight>>();
  /**
   * Logins a turn's harness rejected (`worker/provider/id` → the login file's revision then). CLIs report such a
   * login as signed in (`codex login status` only reads auth.json), so the account shows "expired" until the login
   * file changes (a new sign-in, a refresh), a turn on it succeeds, or, without a revision, a forced refresh.
   */
  readonly #rejected = new Map<string, string>();
  /** Per worker: turn outcomes apply in arrival order, so a slow rejection cannot overwrite a later success. */
  readonly #turnUpdates = new Map<string, Promise<void>>();
  readonly #loginStarts = new Map<string, Promise<LoginStarted>>();

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

    if (!value) return undefined;
    const status = sanitizeAccountStatus(value);
    const key = `${workerId}/${provider}/${id}`;
    const rejected = this.#rejected.get(key);

    if (rejected !== undefined && rejected !== status.loginRevision) this.#rejected.delete(key);
    else if (rejected !== undefined && ["signed_in", "stored"].includes(status.state)) {
      status.state = "expired";
      status.detail = REJECTED_LOGIN_DETAIL;
    }

    // Only the gateway compares revisions; clients get none.
    status.loginRevision = "";

    return status;
  }

  /**
   * A turn on this worker's instance ended because its harness rejected the login. The account is read again first,
   * so the mark holds the login file as it is now: a sign-in after this clears it.
   */
  async rejected(workerId: string, provider: Provider, id: string): Promise<void> {
    const connection = this.core.link.connections.get(workerId);
    const version = this.#reports.get(workerId)?.version;

    if (!connection || version === undefined || !(await this.refresh(connection, version, true, provider, id))) return;
    const account = this.#reports.get(workerId)?.accounts.get(`${provider}/${id}`);

    if (!account || !["signed_in", "stored"].includes(account.state) || !signInMethods.has(account.authMethod)) return;
    this.#rejected.set(`${workerId}/${provider}/${id}`, account.loginRevision);
    await this.#changed();
  }

  /** A turn on the instance succeeded: its login works. */
  async succeeded(workerId: string, provider: Provider, id: string): Promise<void> {
    if (this.#rejected.delete(`${workerId}/${provider}/${id}`)) await this.#changed();
  }

  /** Runs after every earlier turn update of this worker; resolves when this one is done. */
  afterTurn(workerId: string, update: () => Promise<void>): Promise<void> {
    const next = (this.#turnUpdates.get(workerId) ?? Promise.resolve()).then(update).catch(() => {});
    this.#turnUpdates.set(workerId, next);
    void next.then(() => {
      if (this.#turnUpdates.get(workerId) === next) this.#turnUpdates.delete(workerId);
    });

    return next;
  }

  /** One sign-in start per owner and target at a time: concurrent requests share it. */
  startLogin(key: string, start: () => Promise<LoginStarted>): Promise<LoginStarted> {
    const running = this.#loginStarts.get(key);

    if (running) return running;
    const task = start().finally(() => this.#loginStarts.delete(key));
    this.#loginStarts.set(key, task);

    return task;
  }

  /** Cheap check before a thread lookup on every finished turn. */
  hasRejected(workerId: string): boolean {
    for (const key of this.#rejected.keys()) if (key.startsWith(`${workerId}/`)) return true;

    return false;
  }

  async #changed(): Promise<void> {
    coreProvidersChanged(this.core);
    await coreBroadcastWorkers(this.core);
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
        this.#save(connection, result.providerAccounts, provider, id, refresh);
        await this.#changed();

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
    // ConfigApplied also signals completed CLI auth. A read started before this event
    // may still contain the pending login, so read again after that report settles.
    const pending = this.#flights.get(connection)?.get(`${version}/${Provider.UNSPECIFIED}/`);
    void (pending?.task ?? Promise.resolve()).then(() => this.refresh(connection, version));
  }

  #save(
    connection: WorkerConnection,
    report: ProviderAccountsReport,
    provider: Provider,
    id: string,
    refresh: boolean,
  ): void {
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
      const account = sanitizeAccountStatus(entry.account);
      accounts.set(`${entry.provider}/${entry.profileId}`, account);

      // A login kept outside a file (keychain) has no revision: asking for a fresh check is the only sign-in signal.
      if (refresh && !account.loginRevision)
        this.#rejected.delete(`${connection.workerId}/${entry.provider}/${entry.profileId}`);
    }

    this.#reports.set(connection.workerId, { connection, version: report.configVersion, accounts });
  }
}
