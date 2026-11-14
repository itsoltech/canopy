import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { isUuid } from "@canopy/domain/humanize";
import { Effect } from "effect";
import { harnessOf, InstanceStore } from "../store/index.ts";
import { coreState, describeError, InvalidError, UnavailableError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreModelCatalogs, corePublishModels } from "./core-models.ts";
import { coreBroadcastWorkers, coreRun } from "./core-broadcast.ts";
import { coreProxyMethods, type CoreProxyMethods } from "./core-proxies.ts";

export async function coreInstance(
  hostContext: GatewayCore,
  harness: Provider,
  id: string,
): Promise<ui.ProviderInstance> {
  const name = harnessOf(harness);

  if (!name) throw new InvalidError("choose Claude or Codex");

  return coreInstances(hostContext, (s) => s.get(name, id, hostContext[coreState].options.userId));
}

/** The stored configurations go to the workers (each answers ConfigApplied and a new model catalog). */
export async function coreConfigsChanged(hostContext: GatewayCore, workerIds: readonly string[]): Promise<void> {
  if (hostContext[coreState].actions.defer(() => coreConfigsChanged(hostContext, workerIds))) return;

  for (const workerId of workerIds) {
    const config = await coreRun(hostContext, (s) => s.workerConfig(workerId));

    if (config) hostContext.link.pushConfig(workerId, config);
    await hostContext.environment.sync(workerId);
  }

  await coreBroadcastWorkers(hostContext);
  coreProvidersChanged(hostContext);
}

export function coreProvidersChanged(hostContext: GatewayCore): void {
  hostContext.hub.publishOverview(
    create(ui.OverviewUpdateSchema, { change: { case: "providerInstancesChanged", value: true } }),
  );
}

export function coreInstances<A, E>(
  hostContext: GatewayCore,
  use: (store: InstanceStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(InstanceStore.use(use));
}

/** Workers with their instances (Worker.provider_instances). */
export async function coreWorkers(hostContext: GatewayCore): Promise<ui.Worker[]> {
  const [workers, instances] = await Promise.all([
    coreRun(hostContext, (s) => s.listWorkers(hostContext.online, hostContext[coreState].options.userId)),
    coreInstances(hostContext, (s) => s.workerInstances()),
  ]);

  for (const worker of workers) {
    worker.providerInstances = instances.get(worker.id) ?? [];

    for (const instance of worker.providerInstances) {
      instance.account = instance.enabled
        ? hostContext.accounts.get(worker.id, instance.harness, instance.id, worker.configVersion)
        : undefined;

      if (instance.status) instance.status.account = instance.account;
    }

    worker.networkRouteStatus = hostContext.link.connections.get(worker.id)?.networkRouteStatus;
  }

  await hostContext.cli.decorate(workers);

  return workers;
}

export interface CoreProvidersMethods extends CoreProxyMethods {
  listProviderInstances(): Promise<ui.ProviderInstance[]>;
  saveProviderInstance(request: ui.SaveProviderInstanceRequest): Promise<ui.ProviderInstance>;
  deleteProviderInstance(request: ui.DeleteProviderInstanceRequest): Promise<void>;
  setInstanceWorkers(request: ui.SetInstanceWorkersRequest): Promise<ui.ProviderInstance>;
  setInstanceWorker(request: ui.SetInstanceWorkerRequest): Promise<ui.ProviderInstance>;
  setInstanceModels(request: ui.SetInstanceModelsRequest): Promise<ui.ProviderInstance>;
  refreshProviders(request: ui.RefreshProvidersRequest): Promise<ui.RefreshProvidersResponse>;
  installCli(request: ui.InstallCliRequest): Promise<ui.InstallCliResponse>;
  checkCliUpdates(request: ui.CheckCliUpdatesRequest): Promise<ui.CheckCliUpdatesResponse>;
  setWorkerCliUpdateSettings(request: ui.SetWorkerCliUpdateSettingsRequest): Promise<void>;
  startProviderLogin(request: ui.StartProviderLoginRequest): Promise<ui.StartProviderLoginResponse>;
  syncProviderInstances(): Promise<void>;
}

export const coreProvidersMethods: CoreProvidersMethods = {
  ...coreProxyMethods,
  // ------------------------------------------------------------------ provider instances

  /** Every global instance with its state on every worker; no secret values, only whether they are set. */
  async listProviderInstances(this: GatewayCore): Promise<ui.ProviderInstance[]> {
    return this.accounts.decorate(await coreInstances(this, (s) => s.list(this[coreState].options.userId)));
  },

  /** New or changed instance: new configuration versions for the workers it runs on, sent to the online ones. */
  async saveProviderInstance(this: GatewayCore, request: ui.SaveProviderInstanceRequest): Promise<ui.ProviderInstance> {
    const { harness, id, changed } = await coreInstances(this, (s) =>
      s.save({ userId: this[coreState].options.userId, request }),
    );

    await coreConfigsChanged(this, changed);

    return coreInstances(this, (s) => s.get(harness, id));
  },

  async deleteProviderInstance(this: GatewayCore, request: ui.DeleteProviderInstanceRequest): Promise<void> {
    await coreInstance(this, request.harness, request.id);
    await coreConfigsChanged(
      this,
      await coreInstances(this, (s) => s.remove({ userId: this[coreState].options.userId, request })),
    );
  },

  async setInstanceWorkers(this: GatewayCore, request: ui.SetInstanceWorkersRequest): Promise<ui.ProviderInstance> {
    await coreInstance(this, request.harness, request.id);
    await coreConfigsChanged(
      this,
      await coreInstances(this, (s) => s.setWorkers({ userId: this[coreState].options.userId, request })),
    );

    return coreInstance(this, request.harness, request.id);
  },

  async setInstanceWorker(this: GatewayCore, request: ui.SetInstanceWorkerRequest): Promise<ui.ProviderInstance> {
    await coreInstance(this, request.harness, request.id);
    await coreConfigsChanged(
      this,
      await coreInstances(this, (s) => s.setWorker({ userId: this[coreState].options.userId, request })),
    );

    return coreInstance(this, request.harness, request.id);
  },

  /** Favorites, visibility and custom models: pickers change at once, the workers' configurations do not. */
  async setInstanceModels(this: GatewayCore, request: ui.SetInstanceModelsRequest): Promise<ui.ProviderInstance> {
    await coreInstance(this, request.harness, request.id);
    await coreInstances(this, (s) => s.setModels(request));
    await corePublishModels(this, await coreModelCatalogs(this));
    await coreBroadcastWorkers(this);
    coreProvidersChanged(this);

    return coreInstance(this, request.harness, request.id);
  },

  /**
   * Versions, availability and logins checked again on the online workers (ProbeProviders: each answers with a new
   * ConfigApplied for the same version). Workers that are offline or too old are listed as skipped.
   */
  async refreshProviders(this: GatewayCore, request: ui.RefreshProvidersRequest): Promise<ui.RefreshProvidersResponse> {
    if (request.harness || request.id) {
      if (!request.harness || !request.id) throw new InvalidError("choose an instance and harness");
      await coreInstance(this, request.harness, request.id);
    }

    const workers = (await coreWorkers(this)).filter((w) => !request.workerId || w.id === request.workerId);

    if (request.workerId && workers.length === 0) throw new InvalidError("worker not found");
    const skipped: string[] = [];
    await Promise.all(
      workers.map(async (worker) => {
        const connection = this.link.connections.get(worker.id);

        if (!connection?.isOpen) return void skipped.push(`${worker.name}: offline`);

        if (request.accountOnly) {
          if (!(await this.accounts.refresh(connection, worker.configVersion, true, request.harness, request.id)))
            skipped.push(`${worker.name}: account status unavailable`);

          return;
        }

        if (!connection.hello.capabilities.includes("probe_providers"))
          return void skipped.push(`${worker.name}: the worker is too old to check again`);

        const result = await connection
          .sendCommand({ case: "probeProviders", value: {} }, 60_000)
          .catch((cause: unknown) => ({ ok: false, errorMessage: describeError(cause), errorCode: "" }));

        if (!result.ok) skipped.push(`${worker.name}: ${result.errorMessage || result.errorCode}`);
        else if (connection.hello.capabilities.includes("provider_account_status"))
          await this.accounts.refresh(connection, worker.configVersion, true);
      }),
    );

    return create(ui.RefreshProvidersResponseSchema, { instances: await this.listProviderInstances(), skipped });
  },

  /** Installs or updates a provider CLI on the owner's worker(s) (docs/provider-cli.md). */
  installCli(this: GatewayCore, request: ui.InstallCliRequest): Promise<ui.InstallCliResponse> {
    return this.cli.install(request);
  },

  /** Latest CLI versions now, and the owner's online workers report their CLIs again. */
  async checkCliUpdates(this: GatewayCore, request: ui.CheckCliUpdatesRequest): Promise<ui.CheckCliUpdatesResponse> {
    return this.cli.check(request, await coreWorkers(this));
  },

  async setWorkerCliUpdateSettings(this: GatewayCore, request: ui.SetWorkerCliUpdateSettingsRequest): Promise<void> {
    await this.cli.checks.setWorker(request);
    await coreConfigsChanged(this, [request.workerId]);
    void this.cli.checks.tick(request.workerId).catch(() => undefined);
  },

  /** Login of an instance through the harness's API (Codex: ChatGPT device code); the worker finishes it. */
  async startProviderLogin(
    this: GatewayCore,
    request: ui.StartProviderLoginRequest,
  ): Promise<ui.StartProviderLoginResponse> {
    // Signing in replaces the CLI login on that computer: only the worker's own owner may, never on a platform-wide
    // worker other owners also see (listWorkers), and never for a linked computer (not in remote-policy SERVED).
    const userId = this[coreState].options.userId;

    if (!isUuid(request.workerId) || !(await coreRun(this, (s) => s.ownsWorker(request.workerId, userId))))
      throw new InvalidError("worker not found");
    const instance = await coreInstance(this, request.harness, request.id);
    const connection = this.link.connections.get(request.workerId);

    if (!connection?.isOpen) throw new UnavailableError("the worker is offline");

    if (request.harness !== Provider.CODEX)
      throw new InvalidError("only Codex signs in from the app; sign in to Claude Code on the device");

    // An instance on the device login signs the device's Codex in again (worker capability codex_device_login_linked).
    const capability = instance.runtime?.ownLogin ? "codex_device_login" : "codex_device_login_linked";

    if (!connection.hello.capabilities.includes(capability))
      throw new InvalidError("this worker cannot sign in from the app; update it");

    // Repeated clicks share one start; the worker also answers a running sign-in with its code.
    const login = await this.accounts.startLogin(
      `${userId}/${request.workerId}/${request.harness}/${request.id}`,
      async () => {
        const result = await connection.sendCommand(
          { case: "startLogin", value: { provider: request.harness, profileId: request.id } },
          60_000,
        );

        if (!result.ok || !result.login)
          throw new InvalidError(result.errorMessage || result.errorCode || "the login did not start");

        return result.login;
      },
    );

    return create(ui.StartProviderLoginResponseSchema, {
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      loginId: login.loginId,
    });
  },

  /** Writes the effective instances of every worker that is behind (gateway start; after a migration). */
  async syncProviderInstances(this: GatewayCore): Promise<void> {
    await coreConfigsChanged(this, await coreInstances(this, (s) => s.sync(this[coreState].options.userId)));
  },
};
