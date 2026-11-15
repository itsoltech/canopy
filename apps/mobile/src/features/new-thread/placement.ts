import { Provider, type ui } from "@canopy/contracts";
import type { ProjectChoice } from "@canopy/domain/projects";

/**
 * Starting values of a new thread, as on the web (apps/web features/projects/placement.ts and
 * settings/thread-defaults.ts): the project's defaults over yours, then what you used last.
 */

export const modelFor = (defaults: ui.ThreadDefaults, provider: Provider) =>
  defaults.models.find((m) => m.provider === provider)?.model ?? "";

const seconds = (t: ui.Thread) => Number(t.createdAt?.seconds ?? 0n);

/** Main threads you started, newest first. */
const recent = (threads: ui.Thread[]) =>
  threads.filter((t) => !t.parentThreadId && !t.spawnedByAgent).sort((a, b) => seconds(b) - seconds(a));

/** Your default workspace's project, the project you last used, No project, the first that lives on a worker. */
export function defaultProject(projects: ProjectChoice[], threads: ui.Thread[], defaultWorkspaceId: string) {
  return (
    (defaultWorkspaceId ? projects.find((p) => p.workspaces.some((w) => w.id === defaultWorkspaceId)) : undefined) ??
    recent(threads)
      .map((t) => projects.find((p) => p.projectIds.includes(t.projectId)))
      .find((p) => p !== undefined) ??
    projects.find((p) => p.kind === "scratch") ??
    projects.find((p) => p.workspaces.length > 0) ??
    projects[0]
  );
}

/** The default workspace when it is the project's, the one you last used, the first on an online worker. */
export function defaultWorkspace(
  project: ui.Project,
  threads: ui.Thread[],
  defaultWorkspaceId: string,
  online: (workerId: string) => boolean,
) {
  const byId = (id: string) => project.workspaces.find((w) => w.id === id);

  return (
    byId(defaultWorkspaceId) ??
    recent(threads)
      .map((t) => byId(t.workspaceId))
      .find((w) => w !== undefined) ??
    project.workspaces.find((w) => online(w.workerId)) ??
    project.workspaces[0]
  );
}
