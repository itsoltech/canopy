import type { JsonValue } from "@bufbuild/protobuf";
import type { ui } from "@canopy/contracts";
import { agentCatalog } from "@canopy/domain";
import { isEntityId, nodeRef, splitId } from "@canopy/domain/computers";
import { projectChoices, type ProjectChoice } from "@canopy/domain/projects";
import type { ThreadRow } from "../store/index.ts";
import { isAbsolutePath, pathKey, pathStyle } from "../store/paths.ts";
import { BusRefusal, callerTarget } from "./agent-bus-context.ts";
import {
  agentThreadInventory,
  placementAgents,
  type AgentThreadSelection,
  type PlacementInventory,
} from "./agent-thread-inventory.ts";
import type { GatewayCore } from "./core.ts";

export type AgentThreadPlacement = { project: ui.Project; workspace: ui.Workspace; worker: ui.Worker };

const key = (value: string) => value.trim().toLowerCase();

function selectWorker(inventory: PlacementInventory, selector: string | undefined) {
  const workers = [...inventory.workers.values()];

  if (!selector) return workers;
  const exact = inventory.workers.get(key(selector));
  const matches = exact ? [exact] : workers.filter((worker) => key(worker.name) === key(selector));

  if (!matches.length)
    throw new BusRefusal(`Worker “${selector}” was not found. Call list_agents for worker names and IDs.`);

  return matches;
}

function selectProject(inventory: PlacementInventory, selector: string | undefined) {
  const choices = projectChoices(inventory.projects);

  if (!selector) return choices;
  const value = key(selector);

  const ids = new Set(
    inventory.projects.flatMap((p) => (key(p.id) === value || key(p.globalId) === value ? [p.id] : [])),
  );

  const matches = choices.filter((choice) => {
    if (ids.size) return choice.projectIds.some((id) => ids.has(id));

    if (value === "no project") return choice.kind === "scratch";

    return [choice.name, ...choice.aliases].some((name) => key(name) === value);
  });

  if (!matches.length)
    throw new BusRefusal(`Project “${selector}” was not found. Call list_agents for project names and IDs.`);

  return matches;
}

function placements(
  inventory: PlacementInventory,
  choices: ProjectChoice[],
  workers: ui.Worker[],
  project: string | undefined,
) {
  const byWorkspace = new Map(inventory.projects.flatMap((project) => project.workspaces.map((w) => [w.id, project])));
  const eligible = new Set(workers.map((worker) => worker.id));
  const home = project && isEntityId(project) ? splitId(key(project)).node : undefined;

  return choices.map((choice) => ({
    choice,
    destinations: choice.workspaces.flatMap((workspace): AgentThreadPlacement[] => {
      const worker = inventory.workers.get(workspace.workerId);
      const ownerProject = byWorkspace.get(workspace.id);

      return worker && ownerProject && eligible.has(worker.id) && (!home || nodeRef(worker.nodeId) === home)
        ? [{ project: ownerProject, workspace, worker }]
        : [];
    }),
  }));
}

function workspaceMatches({ workspace, worker }: AgentThreadPlacement, selector: string) {
  if (isEntityId(selector)) return key(workspace.id) === key(selector);

  if (workspace.label && key(workspace.label) === key(selector)) return true;

  if (!workspace.rootPath) return false;
  const style = pathStyle(worker.os, workspace.rootPath);

  return (
    isAbsolutePath(selector, style) &&
    pathKey(workspace.rootPath, style, worker.os) === pathKey(selector, style, worker.os)
  );
}

function describeWorker(inventory: PlacementInventory, worker: ui.Worker) {
  const machine = inventory.computers.get(worker.nodeId);

  return `${worker.name}${machine ? ` on ${machine}` : ""}${worker.online ? "" : " (offline)"}`;
}

function ambiguousPlacement(inventory: PlacementInventory, matches: AgentThreadPlacement[]): never {
  const descriptions = matches.slice(0, 6).map(({ project, worker, workspace }) => {
    const folder = project.kind === "scratch" ? "" : ` ${workspace.rootPath}`;

    return `${project.name} on ${describeWorker(inventory, worker)}${folder} [workspace ${workspace.id}]`;
  });

  const extra = matches.length > descriptions.length ? ` and ${matches.length - descriptions.length} more` : "";

  throw new BusRefusal(
    `Multiple destinations match. Choose a worker or pass a workspace ID. ${descriptions.join(". ")}${extra}.`,
  );
}

function noWorkspace(selection: AgentThreadSelection): never {
  const selected = selection.workspace ? ` matches “${selection.workspace}”` : " matches this project and worker";

  throw new BusRefusal(`No configured workspace${selected}. Call list_agents for configured destinations.`);
}

/** Select a configured workspace before creating a thread, even when the user expressed the destination by name. */
export async function resolveAgentThreadPlacement(
  core: GatewayCore,
  caller: ThreadRow,
  selection: AgentThreadSelection,
): Promise<AgentThreadPlacement> {
  const project = selection.project?.trim();
  const worker = selection.worker?.trim();
  const workspace = selection.workspace?.trim();
  const inventory = await agentThreadInventory(core, caller, { project, worker, workspace });
  const workers = selectWorker(inventory, worker);
  const choices = selectProject(inventory, project || (worker && !workspace ? "No project" : undefined));

  const groups = placements(inventory, choices, workers, project)
    .map(({ choice, destinations }) => ({
      choice,
      matches: workspace
        ? destinations.filter((destination) => workspaceMatches(destination, workspace))
        : destinations,
    }))
    .filter((group) => group.matches.length);

  const matches = groups.flatMap((group) => group.matches);

  // The current checkout is a natural default within the same logical project.
  if (!project && !worker && !workspace) {
    const current = matches.find((entry) => entry.workspace.id === caller.workspace_id);

    if (current) return current;
    throw new BusRefusal("This thread's workspace is unavailable. Call list_agents to choose a destination.");
  }

  if (!matches.length) return noWorkspace(selection);

  if (matches.length === 1) return matches[0]!;

  if (groups.length !== 1 || (worker && new Set(matches.map((entry) => entry.worker.id)).size > 1))
    return ambiguousPlacement(inventory, matches);

  const current = matches.find((entry) => entry.workspace.id === caller.workspace_id);

  if (current) return current;

  if (!worker) {
    const online = matches.filter((entry) => entry.worker.online);

    if (online.length === 1) return online[0]!;
  }

  return ambiguousPlacement(inventory, matches);
}

function workspaceSummary({ workspace, project, worker }: AgentThreadPlacement) {
  return {
    workspace_id: workspace.id,
    project_id: workspace.projectId,
    worker_id: worker.id,
    ...(workspace.label && { name: workspace.label }),
    ...(project.kind !== "scratch" && { path: workspace.rootPath }),
  };
}

/** Compact placement and provider choices. The unfiltered linked catalog is supplied by the existing overlay. */
export async function agentThreadCatalog(
  core: GatewayCore,
  caller: ThreadRow,
  selection: Pick<AgentThreadSelection, "project" | "worker">,
): Promise<Record<string, JsonValue>> {
  const project = selection.project?.trim();
  const worker = selection.worker?.trim();
  const inventory = await agentThreadInventory(core, caller, { project, worker });
  const workers = selectWorker(inventory, worker);
  const choices = selectProject(inventory, project);

  const groups = placements(inventory, choices, workers, project).filter(
    ({ destinations }) => !worker || destinations.length,
  );

  const used = new Set(groups.flatMap(({ destinations }) => destinations.map(({ worker }) => worker.id)));
  const listedWorkers = workers.filter((item) => !project || used.has(item.id));

  if (worker && listedWorkers.length > 1) {
    const matches = listedWorkers.slice(0, 6).map((item) => `${describeWorker(inventory, item)} [${item.id}]`);

    throw new BusRefusal(`Multiple workers match. Pass a worker ID. ${matches.join(". ")}.`);
  }

  if (project && worker && !groups.length) return noWorkspace(selection);
  const selectedWorker = worker && listedWorkers[0];
  const available = selectedWorker ? await placementAgents(core, selectedWorker) : undefined;

  return {
    projects: groups.map(({ choice, destinations }) => ({
      project_id: choice.projectIds.find((id) => key(id) === key(project ?? "")) ?? choice.id,
      name: choice.name,
      ...(choice.aliases.length && { aliases: choice.aliases }),
      workspaces: destinations.map(workspaceSummary),
    })),
    workers: listedWorkers.map((item) => ({
      worker_id: item.id,
      name: item.name,
      online: item.online,
      ...(item.nodeId && { computer: inventory.computers.get(item.nodeId) ?? "Linked computer" }),
    })),
    ...(available && {
      agents: agentCatalog(callerTarget(caller), available.instances).agents,
      ...(available.modelsLoading && { models_loading: true }),
    }),
  };
}
