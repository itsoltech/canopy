import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui, WorkspaceCopyOperationSchema, WorkspaceCopyReadSchema, type WorkspaceCopyEntry } from "@canopy/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { copyTotals } from "@canopy/domain/workspace-copy";
import { splitId, qualifyId } from "@canopy/domain/computers";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import { forward, peerOf } from "../api/routed-home.ts";
import { single } from "../api/routed-context.ts";
import { ConfigIds } from "../api/routed-config.ts";
import { copySource } from "./source.ts";
import { copyTarget } from "./target.ts";

const active = new WeakMap<GatewayCore, Set<string>>();

/** One acknowledged chunk in flight. Disk writes complete before reading the next; capped at 8 MiB/s. */
export async function* copyWorkspace(core: GatewayCore, request: ui.CopyWorkspaceRequest, signal: AbortSignal) {
  if (!z.uuid().safeParse(request.transferKey).success) throw new InvalidError("Invalid transfer identifier.");
  const running = active.get(core) ?? new Set<string>();

  if (running.has(request.transferKey) || running.size >= 2)
    throw new InvalidError("Two copies are already running. Wait for one to finish.");
  active.set(core, running);
  running.add(request.transferKey);
  let prepared = false;
  let completed = false;
  let totalFiles = 0;
  let totalBytes = 0n;
  let files = 0;
  let bytes = 0n;
  let skipped = 0;

  const source = async (input: MessageInitShape<typeof ui.WorkspaceCopySourceRequestSchema>, abort = signal) => {
    const call = create(ui.WorkspaceCopySourceRequestSchema, {
      ...input,
      workspaceId: request.sourceRef,
      token: request.manifestToken,
    });

    const node = splitId(request.sourceRef).node;

    if (!node) return copySource(core, call);

    return single<ui.WorkspaceCopySourceResponse>(
      forward(core, await peerOf(core, node), ui.GatewayService.method.workspaceCopySource, call, abort),
    );
  };

  const target = async (operation: MessageInitShape<typeof WorkspaceCopyOperationSchema>, abort = signal) => {
    const node = splitId(request.targetRef).node;
    let projectId = request.projectRef;
    const projectNode = splitId(projectId).node;

    if (!node && projectNode)
      projectId = (await (await ConfigIds.for(core, await peerOf(core, projectNode))).projects()).toLocal(projectId);

    const call = create(ui.WorkspaceCopyTargetRequestSchema, {
      workerId: request.targetRef,
      projectId,
      sourceRef:
        !splitId(request.sourceRef).node && core.computers
          ? qualifyId(request.sourceRef, core.computers.hello().nodeId)
          : request.sourceRef,
      operation,
    });

    if (!node) return copyTarget(core, call);
    const home = await peerOf(core, node);

    const result = await single<ui.WorkspaceCopyTargetResponse>(
      forward(core, home, ui.GatewayService.method.workspaceCopyTarget, call, abort),
    );

    if (result.workspaceRef) result.workspaceRef = qualifyId(result.workspaceRef, home);

    return result;
  };

  try {
    signal.throwIfAborted();

    const authorized = await source({
      authorize: true,
      paths: request.paths,
      ignoredSelection: request.ignoredSelection,
      confirmedSecrets: request.confirmedSecrets,
    });

    const selected = authorized.entries;
    skipped = authorized.skipped;

    const totals = copyTotals(selected);
    totalFiles = totals.files;
    totalBytes = totals.bytes;
    prepared = true;

    const existing = await target({
      action: {
        case: "prepare",
        value: {
          token: request.transferKey,
          parentPath: request.parentPath,
          name: request.name,
          entries: selected,
          bytes: totalBytes,
        },
      },
    });

    const progress = (status: string, currentFile = "", workspaceRef = "") =>
      create(ui.WorkspaceCopyProgressSchema, {
        status,
        currentFile,
        workspaceRef,
        bytes,
        files,
        totalFiles,
        totalBytes,
        skipped,
      });

    if (existing.workspaceRef) {
      bytes = totalBytes;
      files = totalFiles;
      completed = true;
      yield progress("completed", "", existing.workspaceRef);

      return;
    }

    yield progress("copying");
    const total = createHash("sha256");

    for (const entry of selected.filter((e) => !e.directory)) {
      for await (const chunk of transferFile(entry, request, source, target, signal)) {
        bytes += BigInt(chunk.bytes);

        if (chunk.last) {
          total.update(`${entry.path}\0${entry.size}\0${chunk.hash}\n`);
          files++;
        }

        yield progress("copying", entry.secret ? "Local configuration" : entry.path);
      }
    }

    signal.throwIfAborted();
    yield progress("finishing");

    const result = await target({
      action: { case: "finish", value: { token: request.transferKey, sha256: total.digest("hex") } },
    });

    completed = true;
    yield progress("completed", "", result.workspaceRef);
  } finally {
    const cleanup = AbortSignal.timeout(15_000);

    if (prepared && !completed)
      await target({ action: { case: "cancel", value: request.transferKey } }, cleanup).catch(() => {});
    await source({ release: true }, cleanup).catch(() => {});
    running.delete(request.transferKey);
  }
}

async function* transferFile(
  entry: WorkspaceCopyEntry,
  request: ui.CopyWorkspaceRequest,
  source: (
    input: MessageInitShape<typeof ui.WorkspaceCopySourceRequestSchema>,
  ) => Promise<ui.WorkspaceCopySourceResponse>,
  target: (operation: MessageInitShape<typeof WorkspaceCopyOperationSchema>) => Promise<ui.WorkspaceCopyTargetResponse>,
  signal: AbortSignal,
) {
  let offset = 0n;
  const hash = createHash("sha256");

  do {
    signal.throwIfAborted();
    const started = performance.now();

    const chunk = (
      await source({
        read: create(WorkspaceCopyReadSchema, {
          token: request.manifestToken,
          path: entry.path,
          offset,
        }),
      })
    ).chunk;

    if (!chunk || chunk.offset !== offset || chunk.path !== entry.path || chunk.token !== request.manifestToken)
      throw new InvalidError("The transfer lost its place. Retry the copy.");
    hash.update(chunk.data);
    offset += BigInt(chunk.data.length);

    if (offset > entry.size || (chunk.last && offset !== entry.size) || (!chunk.last && chunk.data.length === 0))
      throw new InvalidError("File integrity check failed. Retry the copy.");
    const fileHash = chunk.last ? hash.digest("hex") : "";

    if (chunk.last && chunk.sha256 !== fileHash) throw new InvalidError("File integrity check failed. Retry the copy.");
    chunk.token = request.transferKey;
    await target({ action: { case: "write", value: chunk } });
    const delay = (chunk.data.length / (8 * 1024 ** 2)) * 1000 - (performance.now() - started);

    if (delay > 0) await Bun.sleep(delay);
    yield { bytes: chunk.data.length, hash: fileHash, last: chunk.last };

    if (chunk.last) return;
  } while (offset <= entry.size);

  throw new InvalidError("File integrity check failed. Retry the copy.");
}
