import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { NotFound } from "../store/index.ts";
import { isAbsolutePath, pathStyle } from "../store/paths.ts";
import { coreState, InvalidError, UnavailableError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreWorkerQuery } from "./core-mentions.ts";
import { corePublishProject } from "./core-projects.ts";
import { coreWorkers } from "./core-providers.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { configLock } from "../config-sync/persistence.ts";

/** A clone may take minutes; the worker stops git at 5 minutes, the gateway waits a little longer. */
export const CLONE_COMMAND_TIMEOUT_MS = 5 * 60_000 + 15_000;

const PROJECT_SOURCES = "project_sources";

/** The last segment of a worker path (`/home/me/GIT/canopy/` → `canopy`), for the new project's name. */
const directoryName = (path: string) =>
  path
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() || path;

/**
 * A directory on one of this gateway's workers becomes a project workspace (docs/linked-computers.md, "Dodawanie
 * projektu na dowolnym komputerze"): an existing directory, a new one with `git init`, or a clone. A linked computer
 * reaches this through the routed `AddProject` call, so it always runs at the worker's home, owner-scoped.
 * A directory whose git origin matches exactly one project here joins it instead of creating a duplicate.
 */
export async function coreAddProject(core: GatewayCore, request: ui.AddProjectRequest): Promise<ui.AddProjectResponse> {
  const worker = (await coreWorkers(core)).find((w) => w.id === request.workerId);

  if (!worker) throw new NotFound("worker not found");
  const connection = core.link.connections.get(worker.id);

  if (!connection?.isOpen) throw new UnavailableError(`${worker.name} is offline`);
  const source = request.source;

  if (source.case !== "directoryPath" && source.case !== "init" && source.case !== "clone")
    throw new InvalidError("Choose a directory, a new project or a Git URL");

  if (source.case !== "directoryPath" && !connection.hello.capabilities.includes(PROJECT_SOURCES))
    throw new InvalidError(`Update Canopy on ${worker.name} to create projects there`);
  const style = (path: string) => pathStyle(worker.os, path);
  const requested = source.case === "directoryPath" ? source.value : source.value.parentPath;

  if (!isAbsolutePath(requested, style(requested))) throw new InvalidError("Choose an absolute directory path");

  const directory =
    source.case === "directoryPath"
      ? (await coreWorkerQuery(core, worker.id, { case: "listDirectory", value: { path: source.value } }, 15_000))
          .directoryPath || source.value
      : (
          await coreWorkerQuery(
            core,
            worker.id,
            source.case === "init"
              ? { case: "initRepository", value: { parentPath: source.value.parentPath, name: source.value.name } }
              : {
                  case: "cloneRepository",
                  value: { parentPath: source.value.parentPath, name: source.value.name, url: source.value.url },
                },
            source.case === "clone" ? CLONE_COMMAND_TIMEOUT_MS : 30_000,
          )
        ).directoryPath;

  const origin = connection.hello.capabilities.includes("workspace_origin")
    ? await coreWorkerQuery(core, worker.id, { case: "readWorkspaceOrigin", value: { repoPath: directory } }, 5_000)
        .then((result) => result.workspaceOrigin)
        .catch(() => "")
    : "";

  return core[coreState].actions.transaction(async () => {
    const userId = core[coreState].options.userId;
    await core[coreState].actions.run(Effect.flatMap(SqlClient.SqlClient, (sql) => configLock(sql, userId)));
    const projects = (await core.overview()).projects.filter((p) => p.kind !== "scratch");

    const existing = projects.find((p) =>
      p.workspaces.some((w) => w.workerId === worker.id && w.rootPath === directory),
    );

    if (existing) throw new InvalidError(`This directory is already in “${existing.name}”.`);

    // The same rule as the merged pickers: every workspace of the project knows this one origin.
    const matches = origin ? await coreRun(core, (s) => s.projectsWithOrigin(userId, origin)) : [];
    const attachTo = matches.length === 1 ? projects.find((p) => p.id === matches[0]!.id) : undefined;
    const project = attachTo ?? (await coreRun(core, (s) => s.createProject(userId, directoryName(directory))));

    const workspace = await coreRun(core, (s) =>
      s.createWorkspace({ projectId: project.id, workerId: worker.id, rootPath: directory, label: worker.name }),
    );

    if (origin) {
      await coreRun(core, (s) => s.setWorkspaceOrigin(userId, workspace, origin));
      workspace.gitOrigin = origin;
      core[coreState].workspaceOrigins.set(`${workspace.id}:${workspace.rootPath}`, {
        at: Date.now(),
        origin: Promise.resolve(origin),
      });
    }

    await corePublishProject(core, project.id);
    const current = (await core.overview()).projects.find((p) => p.id === project.id) ?? project;

    return create(ui.AddProjectResponseSchema, { project: current, workspace, attached: Boolean(attachTo) });
  });
}
