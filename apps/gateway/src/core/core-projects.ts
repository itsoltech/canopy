import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { isAbsolutePath, pathStyle } from "../store/paths.ts";
import { NotFound } from "../store/index.ts";
import { coreState, InvalidError, UnavailableError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreWorkerQuery } from "./core-mentions.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreRun } from "./core-broadcast.ts";
import { decorateOrigins } from "./workspace-origins.ts";

export async function coreValidateWorkspaceDirectory(
  hostContext: GatewayCore,
  workerId: string,
  path: string,
): Promise<void> {
  const worker = (await coreWorkers(hostContext)).find((w) => w.id === workerId);

  if (!worker) throw new NotFound("worker not found");

  if (!isAbsolutePath(path, pathStyle(worker.os, path))) throw new InvalidError("root path must be absolute");
  await coreWorkerQuery(hostContext, workerId, { case: "listDirectory", value: { path } }, 15_000);
}

/** The project with its current workspaces, to every overview stream. */
export async function corePublishProject(hostContext: GatewayCore, projectId: string): Promise<void> {
  const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
  const project = projects.find((p) => p.id === projectId);

  if (project) {
    await decorateOrigins(hostContext, [project]);
    hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));
  }
}

export interface CoreProjectsMethods {
  overview(): Promise<ui.GetOverviewResponse>;
  listDirectory(workerId: string, path: string): Promise<ui.ListDirectoryResponse>;
  createProject(name: string, id?: string): Promise<ui.Project>;
  renameProject(projectId: string, name: string): Promise<ui.Project>;
  archiveProject(projectId: string): Promise<void>;
  createWorkspace(request: ui.CreateWorkspaceRequest): Promise<ui.Workspace>;
  updateWorkspace(request: ui.UpdateWorkspaceRequest): Promise<ui.Workspace>;
  removeWorkspace(workspaceId: string): Promise<void>;
}

export const coreProjectsMethods: CoreProjectsMethods = {
  // ------------------------------------------------------------------ UI operations

  async overview(this: GatewayCore): Promise<ui.GetOverviewResponse> {
    const [workers, projects] = await Promise.all([
      coreWorkers(this),
      coreRun(this, (s) => s.listProjects(this[coreState].options.userId)),
    ]);

    await decorateOrigins(this, projects);

    return create(ui.GetOverviewResponseSchema, { workers, projects, agents: [] });
  },

  async listDirectory(this: GatewayCore, workerId: string, path: string): Promise<ui.ListDirectoryResponse> {
    if (!(await this.overview()).workers.some((w) => w.id === workerId)) throw new NotFound("worker not found");
    const connection = this.link.connections.get(workerId);

    if (!connection?.isOpen) throw new UnavailableError(`worker ${workerId} is offline`);
    const result = await connection.sendCommand({ case: "listDirectory", value: { path } }, 15_000);

    if (!result.ok) throw new InvalidError(result.errorMessage || result.errorCode);

    return create(ui.ListDirectoryResponseSchema, { entries: result.entries, path: result.directoryPath || path });
  },

  async createProject(this: GatewayCore, name: string, id?: string): Promise<ui.Project> {
    const project = await coreRun(this, (s) => s.createProject(this[coreState].options.userId, name, id));
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));

    return project;
  },

  async renameProject(this: GatewayCore, projectId: string, name: string): Promise<ui.Project> {
    await coreRun(this, (s) => s.renameProject(this[coreState].options.userId, projectId, name));
    const project = (await this.overview()).projects.find((p) => p.id === projectId)!;
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));

    return project;
  },

  /** Soft archive through the same thread lifecycle, retaining history and worker files. */
  async archiveProject(this: GatewayCore, projectId: string): Promise<void> {
    await this[coreState].actions.transaction(async () => {
      const project = (await this.overview()).projects.find((p) => p.id === projectId && p.kind !== "scratch");

      if (!project) throw new NotFound("project not found or is system-managed");
      await coreRun(this, (s) => s.lockProject(this[coreState].options.userId, projectId));
      const threads = await this.listThreads(projectId, true);

      for (const thread of threads.filter((t) => !t.parentThreadId)) await this.setThreadArchived(thread.id, true);
      await coreRun(this, (s) => s.archiveProject(this[coreState].options.userId, projectId));
      this.hub.publishOverview(
        create(ui.OverviewUpdateSchema, {
          change: { case: "project", value: { ...project, archivedAt: timestampFromDate(new Date()) } },
        }),
      );
    });
  },

  async createWorkspace(this: GatewayCore, request: ui.CreateWorkspaceRequest): Promise<ui.Workspace> {
    return this[coreState].actions.transaction(async () => {
      const overview = await this.overview();

      if (!overview.projects.some((p) => p.id === request.projectId)) throw new NotFound("project not found");

      if (!overview.workers.some((w) => w.id === request.workerId)) throw new NotFound("worker not found");

      if (overview.projects.find((p) => p.id === request.projectId)?.kind === "scratch")
        throw new InvalidError("scratch workspaces are managed automatically");
      await coreValidateWorkspaceDirectory(this, request.workerId, request.rootPath);

      const workspace = await coreRun(this, (s) =>
        s.createWorkspace({
          projectId: request.projectId,
          workerId: request.workerId,
          rootPath: request.rootPath,
          label: request.label,
        }),
      );

      await corePublishProject(this, workspace.projectId);

      return workspace;
    });
  },

  async updateWorkspace(this: GatewayCore, request: ui.UpdateWorkspaceRequest): Promise<ui.Workspace> {
    if (request.rootPath !== undefined) {
      const workspace = (await this.overview()).projects
        .filter((p) => p.kind !== "scratch")
        .flatMap((p) => p.workspaces)
        .find((w) => w.id === request.workspaceId);

      if (!workspace) throw new NotFound("workspace not found");
      await coreValidateWorkspaceDirectory(this, workspace.workerId, request.rootPath);
    }

    const workspace = await coreRun(this, (s) =>
      s.updateWorkspace(this[coreState].options.userId, {
        workspaceId: request.workspaceId,
        rootPath: request.rootPath,
        label: request.label,
      }),
    );

    await corePublishProject(this, workspace.projectId);

    return workspace;
  },

  async removeWorkspace(this: GatewayCore, workspaceId: string): Promise<void> {
    const workspace = await coreRun(this, (s) => s.removeWorkspace(this[coreState].options.userId, workspaceId));
    await corePublishProject(this, workspace.projectId);
  },
};
