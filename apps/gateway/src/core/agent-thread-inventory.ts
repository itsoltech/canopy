import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { SpawnInstance } from "@canopy/domain";
import { AGENT_BUS, isEntityId, nodeRef, splitId, THREAD_MIRROR } from "@canopy/domain/computers";
import { harnessOf } from "@canopy/domain/harnesses";
import { single } from "../api/routed-context.ts";
import { ConfigIds } from "../api/routed-config.ts";
import { forward } from "../api/routed-home.ts";
import type { ThreadRow } from "../store/index.ts";
import { BusRefusal } from "./agent-bus-context.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";
import { coreSpawnInstances } from "./core-models.ts";
import type { GatewayCore } from "./core.ts";

export type AgentThreadSelection = {
  project?: string | undefined;
  worker?: string | undefined;
  workspace?: string | undefined;
};

export type PlacementInventory = {
  projects: ui.Project[];
  workers: Map<string, ui.Worker>;
  computers: Map<string, string>;
};

function homeOf(selector: string | undefined) {
  return selector && isEntityId(selector) ? (splitId(selector.toLowerCase()).node ?? "") : undefined;
}

/** Only the owner's projects, workers and linked homes. Modern linked homes have durable picker projections. */
export async function agentThreadInventory(
  core: GatewayCore,
  caller: ThreadRow,
  selection: AgentThreadSelection,
): Promise<PlacementInventory> {
  const owner = core[coreState].options.userId;

  if (caller.owner_user_id !== owner) throw new BusRefusal("Thread not found.");

  const [projects, localWorkers, linked] = await Promise.all([
    coreRun(core, (store) => store.listProjects(owner)),
    coreRun(core, (store) => store.listWorkers(core.online, owner)),
    linkedInventory(core, caller, selection),
  ]);

  const workers = [
    ...localWorkers,
    ...linked.flatMap(({ overview, reachable }) =>
      overview ? overview.workers.map((worker) => ({ ...worker, online: reachable && worker.online })) : [],
    ),
  ];

  projects.push(...linked.flatMap(({ overview }) => overview?.projects ?? []));

  return {
    projects: projects.filter((project) => !project.archivedAt),
    workers: new Map(
      workers.flatMap((worker): [string, ui.Worker][] => (worker.revokedAt ? [] : [[worker.id, worker]])),
    ),
    computers: new Map(linked.map(({ node, name }) => [node, name])),
  };
}

async function linkedInventory(core: GatewayCore, caller: ThreadRow, selection: AgentThreadSelection) {
  const { computers } = core;
  const projectHome = homeOf(selection.project);
  const workerHome = homeOf(selection.worker);
  const workspaceHome = homeOf(selection.workspace);
  const qualified = [projectHome, workerHome, workspaceHome].filter(Boolean);
  const home = qualified[0];

  if (new Set(qualified).size > 1 || (home && (workerHome === "" || workspaceHome === "")))
    throw new BusRefusal("Choose a project, worker and workspace on the same computer.");

  if (home && (!computers || caller.memory_audience)) throw new BusRefusal("That computer is no longer linked.");

  if (
    !computers ||
    caller.memory_audience ||
    workerHome === "" ||
    workspaceHome === "" ||
    !(selection.project || selection.worker || selection.workspace)
  )
    return [];

  const peers = (await computers.store.computers()).filter(
    (peer) => peer.relay_role !== "origin" && (!home || nodeRef(peer.node_id) === home),
  );

  if (home && peers.length !== 1) throw new BusRefusal("That computer is no longer linked.");
  const reachable = new Set(computers.reachable());

  return (
    await Promise.all(
      peers.map(async (peer) => {
        const node = peer.node_id;
        const name = peer.display_name || peer.name;
        const capabilities = computers.capabilities(node);

        if (!capabilities.includes(AGENT_BUS)) {
          if (home) throw new BusRefusal(`${name} needs an update for linked agents.`);

          return;
        }

        const online = reachable.has(node);

        const mirrored = capabilities.includes(THREAD_MIRROR)
          ? await computers.mirror.overview(node, online)
          : undefined;

        const overview =
          mirrored?.workers.length || mirrored?.projects.length ? mirrored : cachedOverview(core, node, online);

        if (home && !online && !overview) throw new BusRefusal((await computers.unavailable(node)).rawMessage);

        return { node, name, reachable: online, overview };
      }),
    )
  ).flatMap((peer) => (peer ? [peer] : []));
}

function cachedOverview(core: GatewayCore, node: string, reachable: boolean) {
  const method = ui.GatewayService.method.getOverview;
  const request = create(ui.GetOverviewRequestSchema);

  return core.computers?.reads.read(
    node,
    method,
    request,
    (signal) => single<ui.GetOverviewResponse>(forward(core, node, method, request, signal, false, true)),
    undefined,
    reachable,
  );
}

export async function placementAgents(core: GatewayCore, worker: ui.Worker) {
  const { computers } = core;

  if (!worker.nodeId) return { instances: await coreSpawnInstances(core, worker.id), modelsLoading: false };

  if (!computers) return { instances: [], modelsLoading: false };
  const node = worker.nodeId;
  const method = ui.GatewayService.method.listModels;
  const request = create(ui.ListModelsRequestSchema);
  const reachable = computers.reachable().includes(node);

  const models = computers.reads.read(
    node,
    method,
    request,
    (signal) => single<ui.ListModelsResponse>(forward(core, node, method, request, signal)),
    undefined,
    reachable,
  );

  const profiles = models?.workers.find((catalog) => catalog.workerId === worker.id)?.profiles ?? [];
  const mapped = clone(ui.WorkerSchema, worker);

  await (await ConfigIds.for(core, node)).map(ui.WorkerSchema, mapped, "toLocal");

  const providers = mapped.providerInstances.length
    ? mapped.providerInstances.filter((instance) => instance.enabled && instance.available)
    : profiles.map((profile) => ({
        harness: profile.provider,
        id: profile.profileId,
        label: "",
      }));

  const instances = providers.flatMap((instance): SpawnInstance[] => {
    const harness = harnessOf(instance.harness);
    const provider = worker.providers.find((provider) => provider.provider === instance.harness);

    if (!harness || provider?.available === false) return [];
    const profile = profiles.find((item) => item.provider === instance.harness && item.profileId === instance.id);

    return [
      {
        harness,
        id: instance.id,
        label: instance.label,
        available: true,
        complete: Boolean(profile && !profile.detail),
        ...(profile && {
          models: profile.models.map((model) => ({
            id: model.id,
            resolvedModel: model.resolvedModel,
            label: model.displayName,
            efforts: model.efforts,
            serviceTiers: model.serviceTiers.map((tier) => tier.id),
            defaultEffort: model.defaultEffort,
            isDefault: model.isDefault,
            hidden: model.hidden,
          })),
        }),
      },
    ];
  });

  return { instances, modelsLoading: reachable && !models };
}
