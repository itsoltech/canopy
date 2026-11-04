import { ui } from "@canopy/contracts";
import { MOVE_ITEMS, nodeRef, splitId } from "@canopy/domain/computers";
import type { SelectOption } from "#lib/shared/ui/listbox.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { awayReason, computerName } from "./computers.ts";

/**
 * Stage 8 of docs/linked-computers.md: "Move to…" for this computer's threads and bots. This computer
 * coordinates the move; the BFF only forwards. Moves run in the background and are polled while shown.
 */
export type MoveRef = { kind: "thread" | "bot"; id: string };

export type MoveRequest = { nodeId: string; items?: MoveRef[]; everything?: boolean };

export const previewMove = async (request: MoveRequest) =>
  decode(ui.MovePreviewSchema, await requestJson("PUT", "/api/computers/moves", request, 30_000));

export const startMove = async (request: MoveRequest & { placements: { projectId: string; workspaceId: string }[] }) =>
  decode(ui.MovesSnapshotSchema, await requestJson("POST", "/api/computers/moves", request, 30_000));

export const getMoves = async (batchId = "") =>
  decode(
    ui.MovesSnapshotSchema,
    await requestJson("GET", `/api/computers/moves${batchId ? `?batch=${encodeURIComponent(batchId)}` : ""}`),
  );

/** Direct partners only: a move never passes through a relay. Each option says why it can't receive one now. */
export function moveTargets(computers: Iterable<ui.LinkedComputer>): SelectOption[] {
  return [...computers]
    .filter((c) => !c.viaNodeId)
    .map((c) => {
      const away = awayReason(c);

      const reason =
        away ??
        (c.capabilities.includes(MOVE_ITEMS) ? undefined : `${computerName(c)} needs an update to receive moves.`);

      return {
        value: c.nodeId,
        label: computerName(c),
        icon: "computer-desktop" as const,
        ...(reason ? { description: reason, disabled: true } : { description: "Connected" }),
      };
    });
}

/**
 * Workspaces on the target computer for a moved project's threads: the same project (a shared identity) first,
 * then a project of the same name. No-project scratch directories are not a place to continue a project.
 */
export function targetWorkspaces(
  projects: readonly ui.Project[],
  nodeId: string,
  project: { id: string; name: string },
): SelectOption[] {
  const ref = nodeRef(nodeId);
  const options: (SelectOption & { rank: number })[] = [];

  for (const p of projects) {
    if (p.kind === "scratch") continue;

    for (const workspace of p.workspaces) {
      if (splitId(workspace.id).node !== ref) continue;
      const rank = p.id === project.id ? 0 : p.name.trim().toLowerCase() === project.name.trim().toLowerCase() ? 1 : 2;
      options.push({
        value: workspace.id,
        label: `${p.name} · ${workspace.label || workspace.rootPath}`,
        description: workspace.rootPath,
        icon: "folder",
        rank,
      });
    }
  }

  return options.sort((a, b) => a.rank - b.rank).map(({ rank: _, ...option }) => option);
}

/** The projects of the threads in a preview that can move, each once. */
export function movedProjects(preview: ui.MovePreview | undefined): { id: string; name: string }[] {
  const seen = new Map<string, string>();

  for (const item of preview?.items ?? [])
    if (item.kind === "thread" && !item.blocked && item.projectId) seen.set(item.projectId, item.projectName);

  return [...seen].map(([id, name]) => ({ id, name }));
}

export const finished = (move: ui.ComputerMove) =>
  move.state === "done" || move.state === "aborted" || move.state === "aborting";

/** What a move's state means for the person who started it. */
export function moveState(move: ui.ComputerMove): { label: string; tone: Tone } {
  switch (move.state) {
    case "done":
      return { label: move.role === "target" ? "Arrived" : "Moved", tone: "emerald" };
    case "committed":
      return move.role === "target"
        ? { label: "Arriving…", tone: "sky" }
        : { label: "Moved, confirming…", tone: "sky" };
    case "aborting":
    case "aborted":
      return { label: move.error ? "Not moved" : "Rolled back", tone: "amber" };
    default:
      return { label: "Moving…", tone: "sky" };
  }
}
