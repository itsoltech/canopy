import { create } from "@bufbuild/protobuf";
import { PermissionMode, ui, type GitRefs } from "@canopy/contracts";
import { BusRefusal } from "../core/agent-bus-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { initialBranch } from "./branch-names.ts";
import { createWorktree, type PreparedWorkspace } from "./core-worktrees.ts";
import { discoveredId } from "./discovery.ts";

const fullCommit = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i;

function localBase(refs: GitRefs, baseRef: string) {
  const base = baseRef.trim() || refs.defaultBranch || "HEAD";

  if (fullCommit.test(base)) return base.toLowerCase();

  if (base === "HEAD") return refs.worktrees.find((worktree) => worktree.path === refs.repoRoot)?.headCommit;

  const name = base.replace(/^refs\/(?:heads|remotes)\//, "");

  return refs.refs.find((ref) => ref.name === name)?.commit;
}

/** Resolve an immutable local base before using the worker's hook-free agent checkout. */
export async function prepareAgentStartWorktree(
  core: GatewayCore,
  request: ui.CreateThreadRequest,
): Promise<PreparedWorkspace> {
  if (request.permissionMode === PermissionMode.READ_ONLY)
    throw new BusRefusal("Choose checkout to start a read-only thread.");

  const listing = await core.listGitRefs(create(ui.ListGitRefsRequestSchema, { workspaceId: request.workspaceId }));

  if (!listing.supported || !listing.refs?.isRepo)
    throw new BusRefusal(listing.detail || "Choose a Git workspace to create a worktree.");

  const base = localBase(listing.refs, request.baseRef);

  if (!base || !fullCommit.test(base))
    throw new BusRefusal("Choose an existing branch or full commit in the destination repository.");

  const id = discoveredId(request.workspaceId, request.clientRequestId);
  const suffix = id.slice(-8);

  const branch = initialBranch(listing.settings ?? create(ui.WorktreeSettingsSchema), {
    message: request.initialMessage,
    title: request.title,
    shortId: suffix,
    random: suffix,
  });

  const { row } = await createWorktree(core, { ...request, baseRef: base }, undefined, {
    id,
    branch: branch.endsWith(suffix) ? branch : `${branch}-${suffix}`,
    commandId: `start-thread-worktree/${id}`,
  });

  return { request: { ...request, worktreeId: row.id, cwd: row.path } };
}
