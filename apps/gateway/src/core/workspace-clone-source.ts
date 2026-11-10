import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { NotFound } from "../store/index.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";
import { coreWorkerQuery } from "./core-mentions.ts";

/** Explicit owner-scoped read: clone URLs never enter overview, mirrors or the database. */
export async function coreWorkspaceCloneSource(core: GatewayCore, workspaceId: string) {
  const projects = await coreRun(core, (store) => store.listProjects(core[coreState].options.userId));

  const workspace = projects
    .filter((p) => p.kind !== "scratch")
    .flatMap((p) => p.workspaces)
    .find((w) => w.id === workspaceId);

  if (!workspace) throw new NotFound("workspace not found");
  const connection = core.link.connections.get(workspace.workerId);

  if (!connection?.hello.capabilities.includes("workspace_clone_source"))
    return create(ui.GetWorkspaceCloneSourceResponseSchema);

  const result = await coreWorkerQuery(
    core,
    workspace.workerId,
    {
      case: "readWorkspaceOrigin",
      value: { repoPath: workspace.rootPath, includeCloneUrl: true },
    },
    5_000,
  );

  return create(ui.GetWorkspaceCloneSourceResponseSchema, { cloneUrl: result.workspaceCloneUrl });
}
