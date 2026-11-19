import type { ui } from "@canopy/contracts";
import { coreState } from "./core-context.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

export const ORIGIN_CACHE_MS = 30_000;
const CACHE_LIMIT = 500;

/** A worker status report can also discover an origin change after a cached probe expires. */
export function workspaceOriginsDue(core: GatewayCore): boolean {
  const { workspaceOrigins: cache, pendingOriginProjects: pending } = core[coreState];

  // At capacity some live workspaces may already have been evicted.
  if (!pending || pending.size || cache.size >= CACHE_LIMIT) return true;
  const now = Date.now();

  for (const entry of cache.values()) if (now - entry.at >= ORIGIN_CACHE_MS) return true;

  return false;
}

export function rememberUnpublishedOrigin(core: GatewayCore, projectId: string): void {
  const pending = core[coreState].pendingOriginProjects;

  if (!pending) return;
  pending.add(projectId);

  if (pending.size > CACHE_LIMIT) core[coreState].pendingOriginProjects = undefined;
}

/** Owner-scoped workspace records only. Cached metadata survives offline workers and gateway restarts. */
export async function decorateOrigins(
  core: GatewayCore,
  projects: readonly ui.Project[],
  changed?: (projectId: string) => void,
): Promise<void> {
  const cache = core[coreState].workspaceOrigins;
  const workspaces = projects.filter((project) => project.kind !== "scratch").flatMap((project) => project.workspaces);
  await Promise.all(
    workspaces.map(async (workspace) => {
      const connection = core.link.connections.get(workspace.workerId);

      if (!connection?.isOpen || !connection.hello.capabilities.includes("workspace_origin")) return;
      const key = `${workspace.id}:${workspace.rootPath}`;
      let cached = cache.get(key);

      if (!cached || Date.now() - cached.at >= ORIGIN_CACHE_MS) {
        cached = {
          at: Date.now(),
          origin: connection
            .sendCommand({ case: "readWorkspaceOrigin", value: { repoPath: workspace.rootPath } }, 2_500)
            .then((result) => (result.ok ? result.workspaceOrigin : undefined))
            .catch(() => undefined),
        };
        cache.set(key, cached);

        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? "");
      }

      const origin = await cached.origin;

      if (origin === undefined || origin === workspace.gitOrigin) return;
      await coreRun(core, (store) => store.setWorkspaceOrigin(core[coreState].options.userId, workspace, origin));
      workspace.gitOrigin = origin;
      changed?.(workspace.projectId);
    }),
  );
}
