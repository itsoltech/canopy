import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { providerOf } from "../store/instance-config.ts";
import type { AgentBusArgs } from "@canopy/domain";
import type { ThreadRow } from "../store/index.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreLog, coreRun } from "../core/core-broadcast.ts";
import type { GatewayCore } from "../core/core.ts";
import { corePrepareWorkspace } from "./core-worktrees.ts";
import { coreNameBranchLater, coreWorktreeScope } from "./core-worktrees.ts";
import { splitId } from "@canopy/domain/computers";
import { refuseRemoteAutomation } from "./remote.ts";

export const automationModes = {
  checkout: ui.WorkspaceMode.CHECKOUT,
  new_worktree: ui.WorkspaceMode.NEW_WORKTREE,
  inherit_parent: ui.WorkspaceMode.INHERIT_PARENT,
  default: ui.WorkspaceMode.UNSPECIFIED,
};

export function automationMode(name: string): ui.WorkspaceMode {
  switch (name) {
    case "":
    case "default":
      return ui.WorkspaceMode.UNSPECIFIED;
    case "checkout":
      return ui.WorkspaceMode.CHECKOUT;
    case "new_worktree":
      return ui.WorkspaceMode.NEW_WORKTREE;
    case "inherit_parent":
      return ui.WorkspaceMode.INHERIT_PARENT;
    default:
      throw new InvalidError("unknown workspace_mode");
  }
}

/** Called only after bus authorization. An omitted option always inherits, even if the scoped default is new. */
export async function prepareSpawnWorkspace(core: GatewayCore, caller: ThreadRow, args: AgentBusArgs["spawn_thread"]) {
  if (caller.owner_user_id !== core[coreState].options.userId) throw new InvalidError("thread not found");
  let mode = automationModes[args.workspace_mode ?? "inherit_parent"];

  if (args.workspace_mode === "default") {
    const scope = await core.getWorktreeSettings(
      create(ui.GetWorktreeSettingsRequestSchema, {
        projectId: caller.project_id,
        workerId: caller.worker_id ?? "",
      }),
    );

    mode = scope.effective?.defaultMode ?? ui.WorkspaceMode.CHECKOUT;
  }

  return corePrepareWorkspace(
    core,
    create(ui.CreateThreadRequestSchema, {
      parentThreadId: caller.id,
      projectId: caller.project_id,
      workspaceId: caller.workspace_id ?? "",
      provider: providerOf(caller.provider),
      workspaceMode: mode,
      baseRef: args.base_ref ?? "",
      title: args.title,
      initialMessage: args.prompt,
    }),
  );
}

/** A schedule creates a main thread; its optional source supplies placement only, never provider history. */
export async function prepareScheduledWorkspace(
  core: GatewayCore,
  request: ui.CreateThreadRequest,
  userId: string,
  sourceId: string,
) {
  request = await inheritedWorkspace(core, request, userId, sourceId);

  return (await corePrepareWorkspace(core, request)).request;
}

export async function inheritedWorkspace(
  core: GatewayCore,
  request: ui.CreateThreadRequest,
  userId: string,
  sourceId: string,
) {
  if (userId !== core[coreState].options.userId) throw new InvalidError("project not found");

  if (request.workspaceMode === ui.WorkspaceMode.INHERIT_PARENT) {
    if (splitId(sourceId).node) refuseRemoteAutomation("inherit_parent");
    const parent = await coreRun(core, (s) => s.thread(sourceId));

    if (
      parent.owner_user_id !== userId ||
      parent.project_id !== request.projectId ||
      parent.workspace_id !== request.workspaceId
    )
      throw new InvalidError("parent thread must belong to this project and workspace");
    request = create(ui.CreateThreadRequestSchema, {
      ...request,
      cwd: parent.cwd ?? "",
      worktreeId: parent.worktree_id ?? "",
      workspaceMode: parent.worktree_id ? ui.WorkspaceMode.EXISTING_WORKTREE : ui.WorkspaceMode.CHECKOUT,
    });
  }

  return request;
}

/** Only a newly created automation worktree gets a generated name; inherited worktrees keep theirs. */
export async function nameAutomationBranch(core: GatewayCore, thread: ThreadRow, prompt: string) {
  if (!thread.worktree_id || !thread.workspace_id || !thread.worker_id) return;

  try {
    const settings = (await coreWorktreeScope(core, thread.project_id, thread.worker_id)).effective;

    if (settings.branchNaming !== ui.BranchNaming.SEMANTIC) return;

    const worktree = await coreRun(core, (s) =>
      s.ownWorktree(thread.owner_user_id, thread.worktree_id!, thread.project_id, thread.workspace_id!),
    );

    coreNameBranchLater(core, thread, prompt, { worktree, location: settings.location ?? "" });
  } catch {
    coreLog(core, `worktree ${thread.worktree_id}: semantic branch name unavailable; kept`);
  }
}
