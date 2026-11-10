import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { z } from "zod";
import { copyTotals } from "@canopy/domain/workspace-copy";
import type { GatewayCore } from "../core/core.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { coreWorkers } from "../core/core-providers.ts";
import { coreAddProject } from "../core/core-add-project.ts";
import { NotFound } from "../store/index.ts";
import { requireCopyWorker } from "./source.ts";

/** The destination home owns both the database record and the final workspace publication. */
export async function copyTarget(core: GatewayCore, request: ui.WorkspaceCopyTargetRequest) {
  const owner = core[coreState].options.userId;
  const worker = (await coreWorkers(core)).find((w) => w.id === request.workerId);

  const project = (await coreRun(core, (s) => s.listProjects(owner))).find(
    (p) => p.id === request.projectId && p.kind !== "scratch",
  );

  if (!worker || !project) throw new NotFound("project or worker not found");
  requireCopyWorker(core, worker.id);
  const action = request.operation?.action;

  const token =
    action?.case === "cancel"
      ? action.value
      : action?.case === "prepare" || action?.case === "write" || action?.case === "finish"
        ? action.value.token
        : "";

  if (!z.uuid().safeParse(token).success) throw new InvalidError("Invalid transfer identifier.");

  if (action?.case === "prepare") {
    const totals = copyTotals(action.value.entries);
    await coreRun(core, (s) =>
      s.createCopyJob(owner, token, project.id, worker.id, request.sourceRef, totals.files, totals.bytes),
    );
  }

  const job = await coreRun(core, (s) => s.copyJob(owner, token));

  if (job.project_id !== project.id || job.worker_id !== worker.id || job.source_ref !== request.sourceRef)
    throw new NotFound("copy not found");

  if (job.status === "completed")
    return create(ui.WorkspaceCopyTargetResponseSchema, {
      directory: job.directory,
      workspaceRef: job.workspace_id ?? "",
    });

  if (action?.case === "cancel") {
    if (job.status === "writing") {
      await command(core, request);
      await coreRun(core, (s) => s.updateCopyJob(owner, token, "cancelled"));
      await coreRun(core, (s) => s.auditCopy(owner, token, "workspace_copy.cancelled"));
    }

    return create(ui.WorkspaceCopyTargetResponseSchema);
  }

  if (project.workspaces.some((w) => w.workerId === worker.id && w.rootPath !== job.directory))
    throw new InvalidError("This project already has a workspace on this worker.");

  if (action?.case === "prepare") {
    await coreRun(core, (s) => s.auditCopy(owner, token, "workspace_copy.started"));
    await coreRun(core, (s) => s.updateCopyJob(owner, token, "writing"));
  } else if (job.status !== "writing" && !(action?.case === "finish" && job.status === "committed"))
    throw new InvalidError("This copy has ended. Refresh the file list and retry.");

  const result = job.status === "committed" ? { directory: job.directory } : await command(core, request);

  if (action?.case !== "finish" && !(action?.case === "prepare" && result?.directory))
    return create(ui.WorkspaceCopyTargetResponseSchema, { directory: result?.directory ?? "" });
  const directory = result?.directory;

  if (!directory) throw new InvalidError("The copied directory is unavailable. Retry the copy.");
  await coreRun(core, (s) => s.updateCopyJob(owner, token, "committed", directory));
  const existing = project.workspaces.find((w) => w.workerId === worker.id && w.rootPath === directory);

  const workspace =
    existing ??
    (
      await coreAddProject(
        core,
        create(ui.AddProjectRequestSchema, {
          projectId: project.id,
          workerId: worker.id,
          source: { case: "directoryPath", value: directory },
        }),
      )
    ).workspace;

  if (!workspace) throw new InvalidError("The workspace could not be added. Retry the copy.");
  await coreRun(core, (s) => s.updateCopyJob(owner, token, "completed", directory, workspace.id));
  await coreRun(core, (s) => s.auditCopy(owner, token, "workspace_copy.completed"));

  return create(ui.WorkspaceCopyTargetResponseSchema, { directory, workspaceRef: workspace.id });
}

async function command(core: GatewayCore, request: ui.WorkspaceCopyTargetRequest) {
  if (!request.operation) throw new InvalidError("Choose a copy operation.");

  const result = await coreWorkerQuery(
    core,
    request.workerId,
    { case: "workspaceCopy", value: request.operation },
    60_000,
  );

  return result.workspaceCopy;
}
