import { create, clone } from "@bufbuild/protobuf";
import { ui, WorkspaceCopyManifestSchema, type WorkspaceCopyManifest } from "@canopy/contracts";
import { createHash } from "node:crypto";
import { COPY_IDLE_MS, COPY_MAX_BYTES, COPY_MAX_FILE_BYTES, copyTotals } from "@canopy/domain/workspace-copy";
import { WORKSPACE_COPY_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { NotFound } from "../store/index.ts";

interface SourceLease {
  workspace: ui.Workspace;
  manifest: WorkspaceCopyManifest;
  selected: Set<string>;
  expires: number;
}

const leases = new WeakMap<GatewayCore, Map<string, SourceLease>>();
const pathHash = (path: string) => createHash("sha256").update(path).digest("hex");

export async function ownedCopyWorkspace(core: GatewayCore, id: string) {
  const projects = await coreRun(core, (s) => s.listProjects(core[coreState].options.userId));

  const workspace = projects
    .filter((p) => p.kind !== "scratch")
    .flatMap((p) => p.workspaces)
    .find((w) => w.id === id);

  if (!workspace) throw new NotFound("workspace not found");

  return workspace;
}

export function requireCopyWorker(core: GatewayCore, workerId: string) {
  if (!core.link.connections.get(workerId)?.hello.capabilities.includes(WORKSPACE_COPY_CAPABILITY))
    throw new InvalidError("Update this worker to copy files");
}

export async function copyManifest(core: GatewayCore, workspaceId: string) {
  const workspace = await ownedCopyWorkspace(core, workspaceId);
  requireCopyWorker(core, workspace.workerId);

  const result = await coreWorkerQuery(
    core,
    workspace.workerId,
    {
      case: "workspaceCopy",
      value: { action: { case: "scan", value: { rootPath: workspace.rootPath } } },
    },
    120_000,
  );

  const manifest = result.workspaceCopy?.manifest;

  if (!manifest) throw new InvalidError("Could not read the file list. Try again.");
  const preset = await coreRun(core, (s) => s.copyPreset(core[coreState].options.userId, workspace.projectId));
  const included = new Set(preset.included);
  const excluded = new Set(preset.excluded);

  for (const entry of manifest.entries) {
    const hash = pathHash(entry.path);

    if (included.has(hash)) entry.included = !entry.blocked;

    if (excluded.has(hash) && !entry.metadata) entry.included = false;
  }

  const map = leases.get(core) ?? new Map<string, SourceLease>();
  leases.set(core, map);

  for (const [token, lease] of map) if (lease.expires < Date.now()) map.delete(token);
  map.set(manifest.token, { workspace, manifest, selected: new Set(), expires: Date.now() + COPY_IDLE_MS });

  return create(ui.GetWorkspaceCopyManifestResponseSchema, { manifest: clone(WorkspaceCopyManifestSchema, manifest) });
}

export async function copySource(core: GatewayCore, request: ui.WorkspaceCopySourceRequest) {
  const workspace = await ownedCopyWorkspace(core, request.workspaceId);
  requireCopyWorker(core, workspace.workerId);
  const lease = leases.get(core)?.get(request.token);

  if (
    !lease ||
    lease.workspace.id !== workspace.id ||
    lease.workspace.rootPath !== workspace.rootPath ||
    lease.expires < Date.now()
  )
    throw new InvalidError("The file list expired. Refresh it before copying.");
  lease.expires = Date.now() + COPY_IDLE_MS;

  if (request.release) {
    leases.get(core)?.delete(request.token);
    await coreWorkerQuery(
      core,
      workspace.workerId,
      { case: "workspaceCopy", value: { action: { case: "release", value: request.token } } },
      15_000,
    );

    return create(ui.WorkspaceCopySourceResponseSchema);
  }

  if (request.authorize) {
    const paths = new Set(request.paths);
    const selected = lease.manifest.entries.filter((e) => paths.has(e.path));

    if (selected.length !== paths.size || selected.some((e) => e.blocked))
      throw new InvalidError("The selection includes an unavailable file.");

    if (lease.manifest.entries.some((e) => e.metadata && (!paths.has(e.path) || e.blocked)))
      throw new InvalidError(
        "Include all Git metadata to create a usable checkout. Wait for any Git operation to finish, then refresh.",
      );

    if (copyTotals(selected).bytes > COPY_MAX_BYTES || selected.some((e) => e.size > COPY_MAX_FILE_BYTES))
      throw new InvalidError("Choose up to 20 GB in total and 8 GB per file.");
    const confirmed = new Set(request.confirmedSecrets);

    if (selected.some((e) => e.secret && !e.directory && !confirmed.has(e.path)))
      throw new InvalidError("Confirm the selected files that may contain secrets before copying.");
    lease.selected = paths;
    await coreRun(core, (s) =>
      s.saveCopyPreset(
        core[coreState].options.userId,
        workspace.projectId,
        selected.map((e) => pathHash(e.path)),
        lease.manifest.entries.filter((e) => !paths.has(e.path)).map((e) => pathHash(e.path)),
      ),
    );

    return create(ui.WorkspaceCopySourceResponseSchema, {
      entries: selected,
      skipped: lease.manifest.entries.filter((e) => !e.directory && !paths.has(e.path)).length,
    });
  }

  const read = request.read;

  if (!read || read.token !== request.token || !lease.selected.has(read.path))
    throw new InvalidError("This file was not selected for copying.");

  const result = await coreWorkerQuery(
    core,
    workspace.workerId,
    { case: "workspaceCopy", value: { action: { case: "read", value: read } } },
    30_000,
  );

  return create(ui.WorkspaceCopySourceResponseSchema, { chunk: result.workspaceCopy?.chunk });
}
