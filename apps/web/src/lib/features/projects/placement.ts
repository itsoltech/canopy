import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@open-agents/contracts";

/**
 * Where a new thread runs: a project, then one of its workspaces (a directory on a worker the project
 * lives on). The new-thread composer picks both separately; these are its starting values.
 */

/** Main threads you started, newest first: what you used last. */
function recentThreads(threads: Iterable<ui.Thread>): ui.Thread[] {
  const created = (t: ui.Thread) => (t.createdAt ? timestampMs(t.createdAt) : 0);
  return [...threads].filter((t) => !t.parentThreadId && !t.spawnedByAgent).sort((a, b) => created(b) - created(a));
}

/**
 * Project of a new thread: the requested one (`?project=`), the project of your default workspace, the
 * project you last started a thread in, No project, the first project that lives on a worker, the first project.
 */
export function defaultProject(input: {
  projects: readonly ui.Project[];
  threads: Iterable<ui.Thread>;
  requested?: string | undefined;
  /** Your default workspace (Settings → Threads). */
  defaultWorkspaceId?: string | undefined;
}): ui.Project | undefined {
  const { projects, requested, defaultWorkspaceId } = input;
  const byId = (id: string | undefined) => (id ? projects.find((p) => p.id === id) : undefined);
  return (
    byId(requested) ??
    (defaultWorkspaceId ? projects.find((p) => p.workspaces.some((w) => w.id === defaultWorkspaceId)) : undefined) ??
    recentThreads(input.threads)
      .map((t) => byId(t.projectId))
      .find((p) => p !== undefined) ??
    projects.find((p) => p.kind === "scratch") ??
    projects.find((p) => p.workspaces.length > 0) ??
    projects[0]
  );
}

/**
 * Workspace of a new thread in a project: the default workspace (the project's over yours) when it is
 * the project's, the one you last started a thread in, the only one, the first on an online worker, the
 * first. Undefined when the project lives on no worker.
 */
export function defaultWorkspace(input: {
  project: ui.Project;
  threads: Iterable<ui.Thread>;
  /** Effective default workspace (the project's defaults over yours). */
  defaultWorkspaceId?: string | undefined;
  online: (workerId: string) => boolean;
}): ui.Workspace | undefined {
  const { project, defaultWorkspaceId, online } = input;
  const byId = (id: string | undefined) => (id ? project.workspaces.find((w) => w.id === id) : undefined);
  return (
    byId(defaultWorkspaceId) ??
    recentThreads(input.threads)
      .filter((t) => t.projectId === project.id)
      .map((t) => byId(t.workspaceId))
      .find((w) => w !== undefined) ??
    project.workspaces.find((w) => online(w.workerId)) ??
    project.workspaces[0]
  );
}

/** A project's workspaces grouped by worker, in the order of the workers' first workspace. */
export function workspacesByWorker(project: ui.Project): { workerId: string; workspaces: ui.Workspace[] }[] {
  const groups = new Map<string, ui.Workspace[]>();
  for (const ws of project.workspaces) groups.set(ws.workerId, [...(groups.get(ws.workerId) ?? []), ws]);
  return [...groups].map(([workerId, workspaces]) => ({ workerId, workspaces }));
}

/** Last segment of a worker path (`/home/me/app` → `app`, `C:\code\app` → `app`). */
export const baseName = (path: string): string => path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || path;
