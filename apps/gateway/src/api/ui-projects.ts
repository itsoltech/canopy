import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { coreAddProject } from "../core/core-add-project.ts";
import { coreWorkspaceCloneSource } from "../core/workspace-clone-source.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function projectsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getOverview"
  | "watchOverview"
  | "listDirectory"
  | "createProject"
  | "renameProject"
  | "archiveProject"
  | "createWorkspace"
  | "addProject"
  | "getWorkspaceCloneSource"
  | "updateWorkspace"
  | "removeWorkspace"
> {
  return {
    getOverview: () => guard(() => core.overview()),

    watchOverview: (request, context) => core.watchOverview(context.signal, request.includeSnapshot),

    listDirectory: (request) => guard(() => core.listDirectory(request.workerId, request.path)),

    createProject: (request) =>
      guard(async () => create(ui.CreateProjectResponseSchema, { project: await core.createProject(request.name) })),

    renameProject: (request) =>
      guard(async () =>
        create(ui.CreateProjectResponseSchema, { project: await core.renameProject(request.projectId, request.name) }),
      ),

    archiveProject: (request) =>
      guard(async () => {
        await core.archiveProject(request.projectId);

        return create(ui.ArchiveProjectResponseSchema);
      }),

    createWorkspace: (request) =>
      guard(async () => create(ui.CreateWorkspaceResponseSchema, { workspace: await core.createWorkspace(request) })),

    addProject: (request) => guard(() => coreAddProject(core, request)),
    getWorkspaceCloneSource: (request) => guard(() => coreWorkspaceCloneSource(core, request.workspaceId)),

    updateWorkspace: (request) =>
      guard(async () => create(ui.UpdateWorkspaceResponseSchema, { workspace: await core.updateWorkspace(request) })),

    removeWorkspace: (request) =>
      guard(async () => {
        await core.removeWorkspace(request.workspaceId);

        return create(ui.RemoveWorkspaceResponseSchema, {});
      }),
  };
}
