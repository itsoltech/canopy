import type { ui } from "@canopy/contracts";
import { coreState } from "./core-context.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

/** Owner-scoped workspace records only. Cached metadata survives offline workers and gateway restarts. */
export async function decorateOrigins(core: GatewayCore, projects: readonly ui.Project[]): Promise<void> {
  const cache = core[coreState].workspaceOrigins;
  const workspaces = projects.filter((project) => project.kind !== "scratch").flatMap((project) => project.workspaces);
  await Promise.all(
    workspaces.map(async (workspace) => {
      const connection = core.link.connections.get(workspace.workerId);

      if (!connection?.isOpen || !connection.hello.capabilities.includes("workspace_origin")) return;
      const key = `${workspace.id}:${workspace.rootPath}`;
      let cached = cache.get(key);

      if (!cached || Date.now() - cached.at >= 30_000) {
        cached = {
          at: Date.now(),
          origin: connection
            .sendCommand({ case: "readWorkspaceOrigin", value: { repoPath: workspace.rootPath } }, 2_500)
            .then((result) => (result.ok ? result.workspaceOrigin : undefined))
            .catch(() => undefined),
        };
        cache.set(key, cached);

        if (cache.size > 500) cache.delete(cache.keys().next().value ?? "");
      }

      const origin = await cached.origin;

      if (origin === undefined || origin === workspace.gitOrigin) return;
      await coreRun(core, (store) => store.setWorkspaceOrigin(core[coreState].options.userId, workspace, origin));
      workspace.gitOrigin = origin;
    }),
  );
}
