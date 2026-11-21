import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery, WorkerQueryError } from "../core/core-mentions.ts";
import { moduleDisabledMessage, ownerModuleEnabled } from "../store/module-access.ts";
import type { FailedWorktreeReference } from "../store/worktrees.ts";
import { ownWorkspace } from "./core-worktrees.ts";
import { discoveredId, discoverWorkspace } from "./discovery.ts";

const CAPABILITY = "failed_worktree_cleanup_v1";
const REGISTERED = "This worktree is already registered in Canopy.";
const STALE = "The locked worktree changed or is no longer available. Refresh the worktree list.";
const INSPECTION_TIMEOUT_MS = 32_000;
const INSPECTION_BUDGET_MS = 55_000;
const REMOVAL_TIMEOUT_MS = 45_000;

export interface FailedWorktreeCandidate {
  workspace: ui.Workspace;
  worktreeId: string;
  path: string;
}

function supported(core: GatewayCore, workerId: string): string {
  const link = core.link.connections.get(workerId);

  if (!link?.isOpen) return "Reconnect the worker to check this locked worktree.";

  if (!link.hello.capabilities.includes(CAPABILITY))
    return "Update the worker to check whether this locked worktree can be cleaned up.";

  return "";
}

function threadsEnabled(core: GatewayCore) {
  const { actions, options } = core[coreState];

  return actions.run(ownerModuleEnabled(options.userId, "threads"));
}

function references(core: GatewayCore, workerId: string) {
  return coreRun(core, (store) => store.failedWorktreeReferences(workerId));
}

async function failedCleanupQuery(
  core: GatewayCore,
  candidate: FailedWorktreeCandidate,
  refs: readonly FailedWorktreeReference[],
  timeout: number,
  token = "",
) {
  const { workspace, path, worktreeId } = candidate;

  if (refs.some((ref) => ref.kind === "worktree" && (ref.id === worktreeId || ref.path === path)))
    throw new ConnectError(REGISTERED, Code.FailedPrecondition);
  const reason = supported(core, workspace.workerId);

  if (reason) throw new UnavailableError(reason);

  return coreWorkerQuery(
    core,
    workspace.workerId,
    {
      case: "failedWorktreeCleanup",
      value: {
        repoPath: workspace.rootPath,
        path,
        expectedCleanupToken: token,
        expiresAtMs: BigInt(Date.now() + timeout),
        registeredPaths: referencePaths(refs, "worktree"),
        liveThreadPaths: referencePaths(refs, "thread"),
        workspacePaths: referencePaths(refs, "workspace"),
      },
    },
    timeout + 2_000,
  );
}

function referencePaths(refs: readonly FailedWorktreeReference[], kind: FailedWorktreeReference["kind"]) {
  return [...new Set(refs.flatMap((ref) => (ref.kind === kind ? [ref.path] : [])))];
}

/** Settings inventory can contain many locked rows. Cap the concurrent worker scans and the total wait. */
export async function inspectFailedWorktrees(
  core: GatewayCore,
  items: readonly { entry: ui.WorktreeEntry; candidate: FailedWorktreeCandidate }[],
): Promise<void> {
  if (!items.length) return;
  const enabled = await threadsEnabled(core);
  const known = new Map<string, Promise<readonly FailedWorktreeReference[]>>();
  const deadline = Date.now() + INSPECTION_BUDGET_MS;

  const inspect = async ({ entry, candidate }: (typeof items)[number]) => {
    const { workerId, id } = candidate.workspace;
    const reason = enabled ? supported(core, workerId) : moduleDisabledMessage("threads");

    if (reason) {
      entry.failedCleanupReason = reason;

      return;
    }

    try {
      const refs = known.get(workerId) ?? references(core, workerId);
      known.set(workerId, refs);
      const stored = await refs;
      const remaining = deadline - Date.now();

      if (remaining <= 2_000) {
        entry.failedCleanupReason = "Inspection timed out. Narrow the worktree list and refresh to retry.";

        return;
      }

      const result = await failedCleanupQuery(core, candidate, stored, Math.min(remaining, INSPECTION_TIMEOUT_MS));
      const report = result.failedWorktreeCleanup;
      entry.failedCleanupReason =
        report?.reason || (report?.token ? "" : "Canopy could not verify this locked worktree.");

      // The scope is merely a lookup hint. The gateway verifies both ownership and the discovered ID on use.
      if (report?.token) entry.failedCleanupToken = `${id}.${report.token}`;
    } catch (error) {
      entry.failedCleanupReason =
        error instanceof WorkerQueryError || (error instanceof ConnectError && error.code === Code.FailedPrecondition)
          ? error.message
          : "Canopy could not inspect this locked worktree. Refresh to retry.";
    }
  };

  const remaining = items.values();
  await Promise.all(
    Array.from({ length: Math.min(items.length, 4) }, async () => {
      for (const item of remaining) await inspect(item);
    }),
  );
}

export async function cleanUpFailedWorktree(
  core: GatewayCore,
  request: ui.CleanUpFailedWorktreeRequest,
  signal: AbortSignal,
): Promise<void> {
  if (!request.confirmed) throw new ConnectError("Confirm the failed worktree cleanup.", Code.InvalidArgument);
  const separator = request.expectedCleanupToken.indexOf(".");
  const workspaceId = request.expectedCleanupToken.slice(0, separator);
  const token = request.expectedCleanupToken.slice(separator + 1);

  if (separator < 0 || !token || token.length > 512 || !request.worktreeId)
    throw new ConnectError("Refresh the worktree list before confirming cleanup.", Code.InvalidArgument);

  const { project, workspace } = await ownWorkspace(core, workspaceId);

  if (project.kind === "scratch") throw new ConnectError(STALE, Code.FailedPrecondition);
  const reason = supported(core, workspace.workerId);

  if (reason) throw new UnavailableError(reason);

  const refs = await discoverWorkspace(core, workspace, true);

  const tree = refs?.worktrees.find(
    (entry) =>
      entry.locked && entry.path !== refs.repoRoot && discoveredId(workspace.id, entry.path) === request.worktreeId,
  );

  if (!tree || refs?.worktreesDetail) throw new ConnectError(STALE, Code.FailedPrecondition);

  const stored = await references(core, workspace.workerId);

  if (!(await threadsEnabled(core))) throw new ConnectError(moduleDisabledMessage("threads"), Code.FailedPrecondition);
  signal.throwIfAborted();

  const candidate = { workspace, path: tree.path, worktreeId: request.worktreeId };
  await failedCleanupQuery(core, candidate, stored, REMOVAL_TIMEOUT_MS, token);
}
