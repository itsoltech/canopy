import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { define, json, jsonObject, label, object, str } from "./shared.ts";

export const projectTools = [
  define(
    "list_projects",
    "Projects: list the user's projects, including linked computers by machine name, with workspace ids, worker ids and root paths. Pass qualified ids unchanged. kind=scratch is the system No project; it cannot be renamed, archived or manually configured.",
    object({}),
    "Checking projects",
    async ({ core }) =>
      Promise.all(
        (await core.linkedAgents.overview()).projects.map(async (p) => ({
          ...jsonObject(ui.ProjectSchema, p),
          machine: await core.linkedAgents.machine(p.nodeId),
        })),
      ),
    "read",
  ),
  define(
    "create_project",
    "Projects: create a project, then use add_workspace to place it on a worker. Does not create a directory.",
    object({ name: str }, ["name"]),
    (a) => `Creating project ${label(a["name"], "a project")}`,
    ({ core, string, action }) =>
      action(async () => json(ui.ProjectSchema, await core.createProject(string("name", 200)))),
  ),
  define(
    "rename_project",
    "Projects: rename an existing project; workspace paths and thread titles remain independent.",
    object({ project_id: str, name: str }, ["project_id", "name"]),
    (a) => `Renaming ${label(a["project_name"], "a project")}`,
    ({ core, string, action }) =>
      action(async () => json(ui.ProjectSchema, await core.renameProject(string("project_id"), string("name", 200)))),
  ),
  define(
    "archive_project",
    "Projects: archive a project and its workspaces, archive its threads and cancel its schedules. Keeps history and files on workers. Requires approval.",
    object({ project_id: str }, ["project_id"]),
    (a) => `Archiving ${label(a["project_name"], "a project")}`,
    ({ core, string, action }) =>
      action(async () => {
        await core.archiveProject(string("project_id"));

        return { archived: true };
      }),
    "approval",
  ),
  define(
    "add_workspace",
    "Projects: add the project on an online worker at any existing absolute root_path accessible to its OS user (list_directory). Uses UI workspace validation. Directory creation is not supported by the UI; ask the user to create a missing directory on the worker.",
    object({ project_id: str, worker_id: str, root_path: str, label: str }, ["project_id", "worker_id", "root_path"]),
    (a) => `Adding ${label(a["project_name"], "a project")} to ${label(a["worker_name"], "a worker")}`,
    ({ core, string, optional, action }) =>
      action(async () =>
        json(
          ui.WorkspaceSchema,
          await core.createWorkspace(
            create(ui.CreateWorkspaceRequestSchema, {
              projectId: string("project_id"),
              workerId: string("worker_id"),
              rootPath: string("root_path"),
              label: optional("label"),
            }),
          ),
        ),
      ),
  ),
  define(
    "update_workspace",
    "Projects: change a workspace label or directory on the same worker. Existing threads retain their cwd; a new root_path must be absolute, exist and be accessible on the online worker.",
    object({ workspace_id: str, root_path: str, label: str }, ["workspace_id"]),
    "Updating a workspace",
    ({ core, string, optional, args, action }) =>
      action(async () =>
        json(
          ui.WorkspaceSchema,
          await core.updateWorkspace(
            create(ui.UpdateWorkspaceRequestSchema, {
              workspaceId: string("workspace_id"),
              ...(args["root_path"] !== undefined && { rootPath: string("root_path") }),
              ...(args["label"] !== undefined && { label: optional("label") }),
            }),
          ),
        ),
      ),
  ),
  define(
    "remove_workspace",
    "Projects: remove a workspace from new thread placement, keeping files and existing threads. Requires approval.",
    object({ workspace_id: str }, ["workspace_id"]),
    "Removing a workspace",
    ({ core, string, action }) =>
      action(async () => {
        await core.removeWorkspace(string("workspace_id"));

        return { removed: true };
      }),
    "approval",
  ),
];
