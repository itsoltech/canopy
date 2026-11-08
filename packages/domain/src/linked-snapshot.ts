import type { ui } from "@canopy/contracts";
import { awayReason, formatPresenceTime } from "./computer-presence.ts";
import { nodeRef, splitId } from "./computers.ts";

const computerOf = (computers: readonly ui.LinkedComputer[], node: string) =>
  computers.find((computer) => computer.nodeId === node || nodeRef(computer.nodeId) === node);

/** Snapshots and legacy upserts can overlap. The latest value wins without moving the row. */
export const upsertLinkedRows = <T extends { id: string }>(previous: readonly T[], incoming: readonly T[]): T[] => [
  ...new Map([...previous, ...incoming].map((row) => [row.id, row])).values(),
];

/** A home snapshot replaces that home's rows; overlapping rows still have one stable identity. */
export const replaceComputerRows = <T extends { id: string; nodeId: string }>(
  previous: readonly T[],
  incoming: readonly T[],
  nodeId: string,
): T[] =>
  upsertLinkedRows(
    previous.filter((row) => row.nodeId !== nodeId),
    incoming,
  );

/** Aggregate refreshes may be partial even before liveness expires. Per-home snapshots and removals reconcile deletions. */
export function retainLinkedRows<T extends { id: string; nodeId: string }>(
  previous: readonly T[],
  incoming: readonly T[],
  computers: readonly ui.LinkedComputer[],
): T[] {
  const ids = new Set(incoming.map((row) => row.id));

  return upsertLinkedRows(
    [],
    [
      ...incoming,
      ...previous.filter((row) => {
        const computer = row.nodeId && computerOf(computers, row.nodeId);

        return computer && !ids.has(row.id);
      }),
    ],
  );
}

/** Preserve reported worker state separately so a presence flap never destroys the last known snapshot. */
export const workersWithAvailability = (workers: readonly ui.Worker[], computers: readonly ui.LinkedComputer[]) =>
  workers.map((worker) =>
    worker.nodeId && awayReason(computerOf(computers, worker.nodeId), formatPresenceTime)
      ? { ...worker, online: false }
      : worker,
  );

/** Shared rows can be local while some workspaces belong to an unavailable peer. */
export function retainProjects(
  previous: readonly ui.Project[],
  incoming: readonly ui.Project[],
  computers: readonly ui.LinkedComputer[],
): ui.Project[] {
  return retainLinkedRows(previous, incoming, computers).map((project) => {
    const ids = new Set(project.workspaces.map((workspace) => workspace.id));

    const retained =
      previous
        .find((row) => row.id === project.id)
        ?.workspaces.filter((workspace) => {
          const node = splitId(workspace.workerId).node;
          const computer = node && computerOf(computers, node);

          return computer && !ids.has(workspace.id);
        }) ?? [];

    return { ...project, workspaces: upsertLinkedRows(project.workspaces, retained) };
  });
}

/** An authoritative home snapshot or unlink replaces its workspaces, including those in shared local projects. */
export const forgetComputerProjects = (projects: readonly ui.Project[], nodeId: string): ui.Project[] =>
  projects.flatMap((project) =>
    project.nodeId === nodeId
      ? []
      : [
          {
            ...project,
            workspaces: project.workspaces.filter((workspace) => splitId(workspace.workerId).node !== nodeRef(nodeId)),
          },
        ],
  );

/** Shared local projects survive a peer replacement, with only that peer's workspaces reconciled. */
export function replaceComputerProjects(
  previous: readonly ui.Project[],
  incoming: readonly ui.Project[],
  nodeId: string,
): ui.Project[] {
  const projects = new Map(forgetComputerProjects(previous, nodeId).map((project) => [project.id, project]));

  for (const project of incoming) {
    const existing = projects.get(project.id);
    projects.set(project.id, {
      ...(existing && !existing.nodeId ? existing : project),
      workspaces: upsertLinkedRows(existing?.workspaces ?? [], project.workspaces),
    });
  }

  return [...projects.values()];
}

/** A merged project remains actionable when any workspace is local or on an available computer. */
export function projectAwayReason(
  project: ui.Project,
  workers: readonly ui.Worker[],
  computers: readonly ui.LinkedComputer[],
): string | undefined {
  const nodes = project.workspaces.map(
    (workspace) =>
      workers.find((worker) => worker.id === workspace.workerId)?.nodeId ?? splitId(workspace.workerId).node ?? "",
  );

  if (!nodes.length) nodes.push(project.nodeId);
  const reasons = nodes.map((node) => (node ? awayReason(computerOf(computers, node), formatPresenceTime) : undefined));

  return reasons.every(Boolean) ? reasons[0] : undefined;
}
