import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { methodNamed } from "../computers/remote.ts";
import { forward, peerOf } from "../api/routed-home.ts";
import { single } from "../api/routed-context.ts";

/** A remote target is checked at its owner-scoped home; the draft and uploads remain here. */
export async function remoteDraftTitle(
  core: GatewayCore,
  target: ui.ComposerDraftTarget | undefined,
  signal: AbortSignal,
) {
  if (!target) return undefined;
  const thread = target.threadId || target.parentThreadId;
  const node = splitId(thread || target.workspaceId).node;

  if (!node) return undefined;
  const nodeId = await peerOf(core, node);

  if (thread) {
    const method = methodNamed("GetThread");

    if (!method) throw new ConnectError("Thread unavailable", Code.NotFound);

    const result = await single<ui.GetThreadResponse>(
      forward(core, nodeId, method, create(ui.GetThreadRequestSchema, { threadId: thread }), signal),
    );

    if (!result.thread || result.thread.deletedAt) throw new ConnectError("Thread not found", Code.NotFound);

    if (
      target.parentThreadId &&
      (target.projectId !== result.thread.projectId || target.workspaceId !== result.thread.workspaceId)
    )
      throw new ConnectError("Workspace not found", Code.NotFound);

    return result.thread.title || "Thread";
  }

  // Workspace creation is checked by the ordinary home GetOverview read, without accepting arbitrary IDs.
  const method = methodNamed("GetOverview");

  if (!method) throw new ConnectError("Workspace unavailable", Code.NotFound);

  const result = await single<ui.GetOverviewResponse>(
    forward(core, nodeId, method, create(ui.GetOverviewRequestSchema), signal),
  );

  const project = result.projects.find((p) =>
    p.workspaces.some((w) => w.id === target.workspaceId && w.projectId === target.projectId),
  );

  if (!project) throw new ConnectError("Workspace not found", Code.NotFound);

  return `New thread · ${project.name}`;
}
