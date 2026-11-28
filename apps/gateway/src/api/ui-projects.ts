import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState } from "../core/core-context.ts";
import { coreAddProject } from "../core/core-add-project.ts";
import { coreWorkspaceCloneSource } from "../core/workspace-clone-source.ts";
import { coreCloneProject } from "../core/core-clone.ts";
import { watchThreadHeads } from "../core/overview-thread-heads.ts";
import { guard, toConnectError, unwrap } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function projectsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getOverview"
  | "watchOverview"
  | "watchThreadHeads"
  | "listDirectory"
  | "createProject"
  | "renameProject"
  | "setProjectColor"
  | "setProjectImage"
  | "archiveProject"
  | "listProjectSecrets"
  | "putProjectSecret"
  | "deleteProjectSecret"
  | "putProjectLogin"
  | "createWorkspace"
  | "addProject"
  | "cloneProject"
  | "getWorkspaceCloneSource"
  | "updateWorkspace"
  | "removeWorkspace"
> {
  const { userId } = core[coreState].options;

  return {
    getOverview: () => guard(() => core.overview()),

    watchOverview: (request, context) =>
      core.watchOverview(context.signal, request.includeSnapshot, request.threadHeadIds, request.watchMemoryHabits),

    watchThreadHeads: (request, context) => watchThreadHeads(core, request.threadIds, context.signal),

    listDirectory: (request) => guard(() => core.listDirectory(request.workerId, request.path)),

    createProject: (request) =>
      guard(async () => create(ui.CreateProjectResponseSchema, { project: await core.createProject(request.name) })),

    renameProject: (request) =>
      guard(async () =>
        create(ui.CreateProjectResponseSchema, { project: await core.renameProject(request.projectId, request.name) }),
      ),

    setProjectColor: (request) =>
      guard(async () =>
        create(ui.CreateProjectResponseSchema, {
          project: await core.setProjectColor(request.projectId, request.color),
        }),
      ),

    setProjectImage: (request) =>
      guard(async () =>
        create(ui.CreateProjectResponseSchema, {
          project: await core.setProjectImage(request.projectId, request.image),
        }),
      ),

    archiveProject: (request) =>
      guard(async () => {
        await core.archiveProject(request.projectId);

        return create(ui.ArchiveProjectResponseSchema);
      }),

    listProjectSecrets: (request) =>
      guard(async () =>
        create(ui.ListProjectSecretsResponseSchema, {
          secrets: await coreRun(core, (s) => s.listProjectSecrets(userId, request.projectId)),
        }),
      ),

    putProjectSecret: (request) =>
      projectSecretWrite(async () => {
        const secret = await coreRun(core, (s) =>
          s.putProjectSecret(userId, request.projectId, request.name, request.value),
        );

        core.secrets.refresh();

        return create(ui.PutProjectSecretResponseSchema, { secret });
      }),

    putProjectLogin: (request) =>
      projectSecretWrite(async () => {
        const secret = await coreRun(core, (s) => s.putProjectLogin(userId, request));
        core.secrets.refresh();

        return create(ui.PutProjectSecretResponseSchema, { secret });
      }),

    deleteProjectSecret: (request) =>
      projectSecretWrite(async () => {
        await coreRun(core, (s) => s.deleteProjectSecret(userId, request.projectId, request.name));
        core.secrets.refresh();

        return create(EmptySchema);
      }),

    createWorkspace: (request) =>
      guard(async () => create(ui.CreateWorkspaceResponseSchema, { workspace: await core.createWorkspace(request) })),

    addProject: (request) => guard(() => coreAddProject(core, request)),
    cloneProject: (request, context) => coreCloneProject(core, request, context.signal),
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

/** Avoid logging a write request or reflecting unexpected driver errors to the client. */
async function projectSecretWrite<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    const error = unwrap(cause);

    if (error) throw toConnectError(error);
    throw new ConnectError("Project secret operation failed. Try again.", Code.Internal);
  }
}
