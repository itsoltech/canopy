import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui, type WorkspaceCopyOperationSchema } from "@canopy/contracts";
import { splitId, qualifyId } from "@canopy/domain/computers";
import type { GatewayCore } from "../core/core.ts";
import { forward, peerOf } from "../api/routed-home.ts";
import { single } from "../api/routed-context.ts";
import { ConfigIds } from "../api/routed-config.ts";
import { copyManifest, copySource } from "./source.ts";
import { copyTarget } from "./target.ts";

/** Where a copy reads and writes: each side is this gateway or the linked computer that is its home. */
export interface CopyEnds {
  sourceRef: string;
  targetRef: string;
  projectRef: string;
}

export type SourceCall = (
  input: MessageInitShape<typeof ui.WorkspaceCopySourceRequestSchema>,
  abort?: AbortSignal,
) => Promise<ui.WorkspaceCopySourceResponse>;

export type TargetCall = (
  operation: MessageInitShape<typeof WorkspaceCopyOperationSchema>,
  abort?: AbortSignal,
) => Promise<ui.WorkspaceCopyTargetResponse>;

/** A fresh file list of the source workspace, from its home. */
export async function manifestOf(core: GatewayCore, sourceRef: string, signal: AbortSignal) {
  const node = splitId(sourceRef).node;
  const request = create(ui.GetWorkspaceCopyManifestRequestSchema, { workspaceId: sourceRef });

  const response = node
    ? await single<ui.GetWorkspaceCopyManifestResponse>(
        forward(core, await peerOf(core, node), ui.GatewayService.method.getWorkspaceCopyManifest, request, signal),
      )
    : await copyManifest(core, sourceRef);

  return response.manifest;
}

export function sourceCall(core: GatewayCore, ends: CopyEnds, token: string, signal: AbortSignal): SourceCall {
  return async (input, abort = signal) => {
    const call = create(ui.WorkspaceCopySourceRequestSchema, { ...input, workspaceId: ends.sourceRef, token });
    const node = splitId(ends.sourceRef).node;

    abort.throwIfAborted();

    if (!node) return copySource(core, call);

    return single<ui.WorkspaceCopySourceResponse>(
      forward(core, await peerOf(core, node), ui.GatewayService.method.workspaceCopySource, call, abort),
    );
  };
}

export function targetCall(core: GatewayCore, ends: CopyEnds, signal: AbortSignal): TargetCall {
  return async (operation, abort = signal) => {
    const node = splitId(ends.targetRef).node;
    let projectId = ends.projectRef;
    const projectNode = splitId(projectId).node;

    if (!node && projectNode)
      projectId = (await (await ConfigIds.for(core, await peerOf(core, projectNode))).projects()).toLocal(projectId);

    const call = create(ui.WorkspaceCopyTargetRequestSchema, {
      workerId: ends.targetRef,
      projectId,
      sourceRef:
        !splitId(ends.sourceRef).node && core.computers
          ? qualifyId(ends.sourceRef, core.computers.hello().nodeId)
          : ends.sourceRef,
      operation,
    });

    abort.throwIfAborted();

    if (!node) return copyTarget(core, call);
    const home = await peerOf(core, node);

    const result = await single<ui.WorkspaceCopyTargetResponse>(
      forward(core, home, ui.GatewayService.method.workspaceCopyTarget, call, abort),
    );

    if (result.workspaceRef) result.workspaceRef = qualifyId(result.workspaceRef, home);

    return result;
  };
}
