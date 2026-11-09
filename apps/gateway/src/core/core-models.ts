import { create } from "@bufbuild/protobuf";
import { Provider, ui, type ProfileModels } from "@canopy/contracts";
import { Effect } from "effect";
import { type SpawnInstance } from "@canopy/domain";
import {
  applyInstanceModels,
  harnessOf,
  modelProblem,
  ModelStore,
  withCustomModels,
  type ThreadRow,
} from "../store/index.ts";
import { providerOf } from "../store/instance-config.ts";
import { coreState, InvalidError, UnavailableError, type ModelScope } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreInstances, coreWorkers } from "./core-providers.ts";
import { coreRun } from "./core-broadcast.ts";

export async function coreSaveModels(
  hostContext: GatewayCore,
  workerId: string,
  configVersion: bigint,
  profiles: ui.WorkerModels["profiles"],
): Promise<void> {
  const models = await coreModels(hostContext, (s) => s.save({ workerId, configVersion, profiles }));
  await corePublishModels(hostContext, [models]);
}

/** Live catalogs are what pickers show: with the profiles' model selections applied. */
export async function corePublishModels(hostContext: GatewayCore, catalogs: ui.WorkerModels[]): Promise<void> {
  for (const models of await coreForPickers(hostContext, catalogs)) {
    hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "models", value: models } }));
  }
}

/** The instances' model choices: hidden models, custom models, favorites first (store/instance-config.ts). */
export async function coreForPickers(
  hostContext: GatewayCore,
  catalogs: ui.WorkerModels[],
): Promise<ui.WorkerModels[]> {
  if (catalogs.length === 0) return catalogs;
  const rules = await coreInstances(hostContext, (s) => s.modelRules());

  return catalogs.map((catalog) => applyInstanceModels(catalog, rules));
}

/**
 * A model and effort must be offered by the profile's catalog when the worker has reported one (no catalog,
 * or an incomplete one, is not judged: the worker has the final word when the turn starts).
 */
export async function coreCheckModel(
  hostContext: GatewayCore,
  where: ModelScope,
  model: string,
  effort: string,
): Promise<void> {
  const { models, provider, profile } = await coreProfileModels(hostContext, where);
  const problem = modelProblem(models, provider, profile, model, effort);

  if (problem) throw new InvalidError(problem);
}

/** The worker's last catalog for the thread's (or the new thread's) provider and profile. */
export async function coreProfileModels(
  hostContext: GatewayCore,
  where: ModelScope,
): Promise<{ models: ProfileModels | undefined; provider: Provider; profile: string }> {
  let workerId: string | undefined;
  let provider: Provider;
  let profileId: string;

  if ("thread" in where) {
    workerId = where.thread.worker_id ?? undefined;
    provider = providerOf(where.thread.provider);
    profileId = where.thread.provider_profile_id ?? "";
  } else {
    const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
    workerId = projects.flatMap((p) => p.workspaces).find((w) => w.id === where.workspaceId)?.workerId;
    provider = where.provider;
    profileId = where.profileId;
  }

  const profile = profileId && profileId !== "native" ? profileId : "native";
  const catalog = workerId ? (await coreModelCatalogs(hostContext, [workerId])).at(0) : undefined;
  const listed = catalog?.profiles.find((p) => p.provider === provider && p.profileId === profile);

  // The instance's custom models are accepted like listed ones.
  const rule =
    listed &&
    (await coreInstances(hostContext, (s) => s.modelRules())).find(
      (r) => r.harness === harnessOf(provider) && r.id === profile,
    );

  return { models: listed && withCustomModels(listed, rule), provider, profile };
}

/**
 * What a subagent of the thread can run on (docs/agent-bus.md): the provider instances enabled on its worker, as
 * the new-thread pickers offer them (available = harness and instance reported available), with the pickers' model
 * catalogs (hidden, custom and favorite models applied). Undefined until the worker reported its configuration.
 */
export async function coreSpawnInstances(
  hostContext: GatewayCore,
  thread: ThreadRow,
): Promise<SpawnInstance[] | undefined> {
  const worker = (await coreWorkers(hostContext)).find((w) => w.id === thread.worker_id);

  if (!worker || worker.appliedVersion === 0n) return undefined;

  const catalog = (await coreForPickers(hostContext, await coreModelCatalogs(hostContext, [worker.id]))).at(0);

  return worker.providerInstances
    .filter((i) => i.enabled && harnessOf(i.harness))
    .map((instance): SpawnInstance => {
      const harness = harnessOf(instance.harness)!;
      const provider = worker.providers.find((p) => p.provider === instance.harness);
      const profile = worker.profiles.find((p) => p.id === instance.id && p.providers.includes(instance.harness));
      const models = catalog?.profiles.find((p) => p.provider === instance.harness && p.profileId === instance.id);

      const detail = !provider?.available
        ? provider?.detail || `${harness} is not installed`
        : !profile
          ? "not applied on the worker yet"
          : profile.detail || instance.detail;

      return {
        harness,
        id: instance.id,
        label: instance.label,
        available: Boolean(provider?.available && profile?.available && instance.available),
        ...(detail && { detail }),
        ...(models && {
          models: models.models.map((m) => ({
            id: m.id,
            resolvedModel: m.resolvedModel,
            label: m.displayName,
            efforts: m.efforts,
            defaultEffort: m.defaultEffort,
            isDefault: m.isDefault,
            hidden: m.hidden,
          })),
        }),
        complete: Boolean(models && !models.detail),
      };
    });
}

export function coreModels<A, E>(
  hostContext: GatewayCore,
  use: (store: ModelStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(ModelStore.use(use));
}

/** All catalog reads use the gateway's trusted owner context, including provider-change broadcasts. */
export function coreModelCatalogs(hostContext: GatewayCore, workerIds?: readonly string[]): Promise<ui.WorkerModels[]> {
  return coreModels(hostContext, (s) => s.catalogs(hostContext[coreState].options.userId, workerIds));
}

export interface CoreModelsMethods {
  listModels(request: ui.ListModelsRequest): Promise<ui.WorkerModels[]>;
}

export const coreModelsMethods: CoreModelsMethods = {
  // ------------------------------------------------------------------ models and steers

  /** Catalogs of the user's workers; refresh asks the worker(s) again (online ones). */
  async listModels(this: GatewayCore, request: ui.ListModelsRequest): Promise<ui.WorkerModels[]> {
    const workers = (await coreWorkers(this)).filter((w) => !request.workerId || w.id === request.workerId);

    if (request.workerId && workers.length === 0) throw new InvalidError("worker not found");

    if (request.refresh) {
      const online = workers.filter((w) => w.online);

      if (request.workerId && online.length === 0) throw new UnavailableError(`worker ${request.workerId} is offline`);
      await Promise.all(
        online.map(async (worker) => {
          const connection = this.link.connections.get(worker.id);

          if (!connection?.isOpen) return;
          const result = await connection.sendCommand({ case: "listModels", value: {} }, 90_000);

          if (!result.ok) throw new InvalidError(result.errorMessage || result.errorCode);
          await coreSaveModels(this, worker.id, worker.appliedVersion, result.models);
        }),
      );
    }

    const catalogs = await coreModelCatalogs(
      this,
      workers.map((w) => w.id),
    );

    return request.unfiltered ? catalogs : coreForPickers(this, catalogs);
  },
};
