import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { THREAD_WORKTREE_SWITCH_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BusRefusal } from "../core/agent-bus-context.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreRun } from "../core/core-broadcast.ts";
import { coreState } from "../core/core-context.ts";
import { coreWorkerQuery, WorkerQueryError } from "../core/core-mentions.ts";
import type { GatewayCore } from "../core/core.ts";
import { callerMode, insertCall, queueTurn, thread } from "../store/agent-bus-queries.ts";
import { AgentBusStore, type CallSource, type ThreadRow } from "../store/index.ts";
import { isAbsolutePath, normalizePath, pathStyle } from "../store/paths.ts";
import { lockThreadWorktreeSource, switchThreadWorktree } from "../store/thread-worktree-switch.ts";
import { createWorktreeRefusal, UNSAFE_WORKTREE_DESTINATION } from "./automation.ts";
import { createWorktree, ownWorkspace } from "./core-worktrees.ts";
import { adoptWorktree, discoverWorkspace, mergeWorktrees } from "./discovery.ts";

type SwitchArgs = AgentBusArgs["switch_worktree"];

async function checkoutRoot(
  core: GatewayCore,
  workerId: string,
  repoPath: string,
  validateWorktreeDestination = false,
) {
  try {
    const result = await coreWorkerQuery(
      core,
      workerId,
      {
        case: "listGitRefs",
        value: { repoPath, worktreesOnly: true, branchesOnly: true, validateWorktreeDestination },
      },
      5_000,
      { requiredCapability: THREAD_WORKTREE_SWITCH_CAPABILITY },
    );

    return result.gitRefs?.repoRoot;
  } catch (error) {
    if (error instanceof WorkerQueryError && error.code === "WORKTREE_UNSAFE")
      throw new BusRefusal(UNSAFE_WORKTREE_DESTINATION);
    throw error;
  }
}

async function switchTarget(core: GatewayCore, source: CallSource, caller: ThreadRow, args: SwitchArgs) {
  const { project, workspace, worker } = await ownWorkspace(core, caller.workspace_id ?? "");

  if (project.id !== caller.project_id || project.kind !== "project" || workspace.workerId !== caller.worker_id)
    throw new BusRefusal("Choose a worktree in this thread's project workspace.");

  const discovered = await discoverWorkspace(core, workspace, true);

  if (!discovered?.isRepo || discovered.worktreesDetail)
    throw new BusRefusal("The worker could not verify the worktrees of this workspace.");

  const currentRoot = await checkoutRoot(core, workspace.workerId, caller.cwd ?? "");
  const current = discovered.worktrees.find((tree) => tree.path === currentRoot);

  if (!current || current.unavailableReason || !current.headCommit)
    throw new BusRefusal("This thread's directory is outside the workspace repository or its worktree is unavailable.");

  if (args.branch) {
    const request = create(ui.CreateThreadRequestSchema, {
      projectId: project.id,
      workspaceId: workspace.id,
      baseRef: current.headCommit,
    });

    try {
      const { row } = await createWorktree(core, request, undefined, {
        id: source.callId,
        branch: args.branch,
        commandId: `switch-worktree/${caller.id}/${source.callId}`,
        expectedRoot: workspace.rootPath,
      });

      return { workspaceRoot: workspace.rootPath, id: row.id, branch: row.branch, detachedCommit: "" };
    } catch (error) {
      const reason = createWorktreeRefusal(error);

      if (reason) throw new BusRefusal(reason);
      throw error;
    }
  }

  const style = pathStyle(worker.os, workspace.rootPath);

  if (!args.path || !isAbsolutePath(args.path, style))
    throw new BusRefusal("Choose an absolute path to a registered worktree of this repository.");

  const path = normalizePath(args.path, style);

  const live = discovered.worktrees.find((tree) =>
    [tree.path, ...tree.aliases, ...(tree.path === discovered.repoRoot ? [workspace.rootPath] : [])].some(
      (spelling) => normalizePath(spelling, style) === path,
    ),
  );

  if (!live || live.unavailableReason || live.locked || live.prunable || live.missing)
    throw new BusRefusal("Choose an available worktree registered in this workspace repository.");
  const head = { branch: live.branch, detachedCommit: live.detached ? live.headCommit.slice(0, 12) : "" };

  const verifyDestination = async (cwd: string) => {
    if ((await checkoutRoot(core, workspace.workerId, cwd, true)) !== live.path)
      throw new BusRefusal("The destination changed. Refresh and choose a worktree.");
  };

  if (live.path === discovered.repoRoot) {
    await verifyDestination(workspace.rootPath);

    return { workspaceRoot: workspace.rootPath, id: null, ...head };
  }

  const rows = await coreRun(core, (s) =>
    s.listWorktrees(caller.owner_user_id, project.id, workspace.workerId, workspace.id),
  );

  const selected = mergeWorktrees(rows, discovered, workspace).find(
    (tree) => tree.path === live.path || live.aliases.includes(tree.path),
  );

  if (!selected) throw new BusRefusal("This worktree is no longer available.");

  await verifyDestination(selected.path);

  const row = await adoptWorktree(
    core,
    workspace,
    selected,
    rows.find((tree) => tree.id === selected.id),
  );

  return { workspaceRoot: workspace.rootPath, id: row.id, ...head };
}

export async function switchAgentWorktree(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  args: SwitchArgs,
  hops: number,
): Promise<JsonValue> {
  const { actions, options } = core[coreState];
  const workerId = caller.worker_id;

  if (!workerId || !caller.cwd || !source.turnId || caller.owner_user_id !== options.userId)
    throw new BusRefusal("Only the running thread can switch its worktree.");

  if (!core.link.connections.get(workerId)?.hello.capabilities.includes(THREAD_WORKTREE_SWITCH_CAPABILITY))
    throw new BusRefusal("Update and reconnect this worker to switch worktrees.");

  const input = {
    owner: options.userId,
    workerId,
    threadId: caller.id,
    turnId: source.turnId,
    expectedCwd: caller.cwd,
    expectedWorktreeId: caller.worktree_id ?? null,
  };

  // The Git checkout can take minutes. Allow the user to stop the turn while the worker prepares it.
  const previous = await actions.run(AgentBusStore.use((s) => s.storedCall(source.callId)));

  if (previous) {
    if (
      previous.source_thread_id === caller.id &&
      previous.tool === "switch_worktree" &&
      previous.status === "completed"
    )
      return previous.result ?? {};
    throw new BusRefusal("This tool call has already ended.");
  }

  await actions.transaction(() => actions.run(lockThreadWorktreeSource(input)));
  const target = await switchTarget(core, source, caller, args);

  const stored = await actions.transaction(async () => {
    const changed = await actions.run(
      switchThreadWorktree({ ...input, destinationWorktreeId: target.id, expectedWorkspaceRoot: target.workspaceRoot }),
    );

    if (changed.cwd === input.expectedCwd && changed.worktreeId === input.expectedWorktreeId)
      throw new BusRefusal("This thread is already using that worktree.");
    const headChanged = await coreRun(core, (s) => s.saveGitHead(workerId, [caller.id], target, changed.cwd));

    const result = {
      cwd: changed.cwd,
      worktree_id: changed.worktreeId ?? "",
      branch: target.branch,
      detached_commit: target.detachedCommit,
      note: args.continuation
        ? "Finish this turn now. Your continuation is queued in the new working directory."
        : "Finish this turn now. The next turn starts in the new working directory.",
    };

    const turn = await actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertCall(sql, {
          source,
          tool: "switch_worktree",
          args,
          status: "completed",
          result,
          ...(args.continuation && { hops }),
        });

        if (!args.continuation) return undefined;

        return yield* queueTurn(sql, {
          threadId: caller.id,
          trigger: "agent_bus",
          callId: source.callId,
          hops,
          input: {
            note: `[canopy] Continue in the thread's worktree at ${changed.cwd}.`,
            message: args.continuation,
            permissionCeiling: yield* callerMode(sql, source, yield* thread(sql, caller.id)),
          },
        });
      }),
    );

    return { result, turnId: turn?.id ?? "", headChanged };
  });

  for (const id of new Set([caller.id, ...stored.headChanged])) {
    core.githubDetection.request(id);
    await coreBroadcastThread(core, id);
  }

  if (stored.turnId) await coreBroadcastTurn(core, caller.id, stored.turnId);

  return stored.result;
}
