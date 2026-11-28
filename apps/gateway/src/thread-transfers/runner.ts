import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreDeliver } from "../core/core-commands.ts";
import { WorkerQueryError } from "../core/core-mentions.ts";
import { NotFound } from "../store/errors.ts";
import { createWorktree } from "../worktrees/core-worktrees.ts";
import { removeEntry, scanEntry } from "../worktrees/lifecycle.ts";
import { totalDigest, transferFiles } from "../workspace-copy/transfer.ts";
import { commandStatuses, pendingThreadCommands } from "./fences.ts";
import {
  preparedTransfer,
  recordTargetWorktree,
  reserveTargetWorktree,
  transferProgress,
  type SessionPlan,
  type TransferRow,
} from "./store.ts";
import { transferOperation, workerIo } from "./worker-io.ts";

/**
 * Preparing a transfer (docs/thread-transfers.md): the source worker lets go of the family, exports the package,
 * the target stages it, takes the commits, gets a new worktree at the thread's commit and recreates the changes
 * and sessions there. Nothing is visible before the commit; any failure rolls everything back.
 */

const EXPORT_TIMEOUT_MS = 10 * 60_000;
const DRAIN_TIMEOUT_MS = 60_000;

export interface PrepareResult {
  cwd: string;
  worktreeId: string;
}

export async function prepareTransfer(
  core: GatewayCore,
  row: TransferRow,
  signal: AbortSignal,
): Promise<PrepareResult> {
  const { actions } = core[coreState];
  const run = actions.run.bind(actions);
  const progress = (update: Parameters<typeof transferProgress>[1]) => run(transferProgress(row.id, update));
  const workspace = await targetWorkspace(core, row);
  await drainSource(core, row.source_worker_id, row.family, signal);

  await progress({ phase: "exporting" });

  const tips = await transferOperation(core, row.target_worker_id, {
    action: { case: "tips", value: { repoPath: workspace.rootPath } },
  });

  const exported = await transferOperation(
    core,
    row.source_worker_id,
    {
      action: {
        case: "export",
        value: {
          token: row.id,
          cwd: row.source_cwd,
          sessions: row.sessions.map((s) => session(s, s.sourceProfileId)),
          localFiles: row.local_files,
          knownCommits: tips.tips,
          expectedHead: row.expected_head,
        },
      },
    },
    EXPORT_TIMEOUT_MS,
    signal,
  );

  const pkg = exported.package;

  if (!pkg) throw new InvalidError("The source worker did not export the thread.");
  await progress({ phase: "copying", totalBytes: pkg.bytes, bytes: 0n });
  await transferOperation(core, row.target_worker_id, {
    action: { case: "prepare", value: { token: row.id, entries: pkg.entries, bytes: pkg.bytes } },
  });
  let bytes = 0n;
  let reported = 0;

  const hashes = await transferFiles(
    { source: row.id, target: row.id },
    pkg.entries,
    new Map(),
    workerIo(core, row.source_worker_id, row.target_worker_id, signal),
    signal,
    (tick) => {
      bytes += BigInt(tick.bytes);

      if (Date.now() - reported > 1000) {
        reported = Date.now();
        void progress({ bytes }).catch(() => undefined);
      }
    },
  );

  await progress({ phase: "checking_out", bytes: pkg.bytes });

  const staged = await transferOperation(
    core,
    row.target_worker_id,
    {
      action: {
        case: "stage",
        value: { token: row.id, sha256: totalDigest(pkg.entries, hashes), repoPath: workspace.rootPath },
      },
    },
    EXPORT_TIMEOUT_MS,
    signal,
  );

  // Each attempt's worktree id is recorded before it exists, so a rollback after a crash still finds it.
  const worktree = await newWorktree(core, row.id, workspace, staged.head, staged.branch || pkg.branch, (attempt) =>
    run(reserveTargetWorktree(row.id, attempt)),
  );

  await run(recordTargetWorktree(row.id, worktree.path, worktree.id));
  await progress({ phase: "applying" });
  await transferOperation(
    core,
    row.target_worker_id,
    {
      action: {
        case: "apply",
        value: { token: row.id, cwd: worktree.path, sessions: row.sessions.map((s) => session(s, s.targetProfileId)) },
      },
    },
    EXPORT_TIMEOUT_MS,
    signal,
  );
  // Nothing wrote to the source checkout since the export (an editor, a terminal): otherwise the move would drop it.
  await transferOperation(
    core,
    row.source_worker_id,
    { action: { case: "verify", value: { token: row.id, cwd: row.source_cwd } } },
    EXPORT_TIMEOUT_MS,
    signal,
  );
  await run(preparedTransfer(row.id, { cwd: worktree.path, worktreeId: worktree.id }));

  return { cwd: worktree.path, worktreeId: worktree.id };
}

const session = (plan: SessionPlan, profileId: string) => ({
  threadId: plan.threadId,
  provider: plan.provider,
  profileId,
  providerThreadId: plan.providerThreadId,
});

async function targetWorkspace(core: GatewayCore, row: TransferRow) {
  const projects = await coreRun(core, (s) => s.listProjects(core[coreState].options.userId));
  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === row.target_workspace_id);

  if (!workspace || workspace.workerId !== row.target_worker_id)
    throw new InvalidError("The project's workspace on the target worker is gone.");

  return workspace;
}

/**
 * The source runs nothing for the family any more: every runtime is unloaded (each unload completed, none failed or
 * expired) and every event is stored here before its files are read. Bounded from the first delivery.
 */
export async function drainSource(core: GatewayCore, workerId: string, family: readonly string[], signal: AbortSignal) {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const commands = [];

  for (const threadId of family)
    commands.push(
      await coreRun(core, (s) =>
        s.enqueueCommand({
          threadId,
          workerId,
          ttlSeconds: 3600,
          command: { kind: { case: "unloadThread", value: { threadId } } },
        }),
      ),
    );

  for (const command of commands) void coreDeliver(core, workerId, command);
  const ids = commands.map((c) => c.commandId);

  for (;;) {
    signal.throwIfAborted();
    const connection = core.link.connections.get(workerId);

    if (!connection?.isOpen) throw new InvalidError("The thread's worker went offline. Try again when it is back.");
    const unloads = await core[coreState].actions.run(commandStatuses(ids));

    if (unloads.some((status) => status === "failed" || status === "expired"))
      throw new InvalidError("The thread's worker did not let go of the thread. Try again.");
    const pending = await core[coreState].actions.run(pendingThreadCommands(family));

    if (
      unloads.length === ids.length &&
      unloads.every((status) => status === "completed") &&
      !pending &&
      !family.some((id) => connection.hasUnpersistedEvents(id))
    )
      return;

    if (Date.now() > deadline) throw new InvalidError("The thread's worker did not let go of the thread. Try again.");
    await Bun.sleep(250);
  }
}

/** Answers to a replayed checkout that mean it created nothing. */
const DEFINITE_REFUSALS = new Set(["BRANCH_EXISTS", "BAD_REF", "NOT_A_REPOSITORY", "PATH_OUTSIDE_ROOT"]);

/** One try at the move's worktree, recorded before it runs: a cleanup can replay it by its command id. */
export interface WorktreeAttempt {
  id: string;
  commandId: string;
  branch: string;
  head: string;
}

/** A worktree at the thread's commit, on the thread's branch name when it is free on the target. */
export async function newWorktree(
  core: GatewayCore,
  id: string,
  workspace: ui.Workspace,
  head: string,
  branch: string,
  reserve: (attempt: WorktreeAttempt) => Promise<void>,
) {
  const base = branch || `moved-${id.slice(-8)}`;
  const names = [base, `${base}-moved`, ...[2, 3, 4, 5].map((n) => `${base}-moved-${n}`)];

  for (const name of names) {
    const attempt = { id: Bun.randomUUIDv7(), commandId: `thread-transfer/${id}/${name}`, branch: name, head };
    await reserve(attempt);

    try {
      return await attemptWorktree(core, workspace, attempt);
    } catch (error) {
      if (error instanceof WorkerQueryError && error.code === "BRANCH_EXISTS") continue;
      throw error;
    }
  }

  throw new InvalidError(`The branch ${base} and its moved variants already exist on the target worker.`);
}

/** The worker remembers an agent checkout's result by its command id, so a replay returns the same worktree. */
async function attemptWorktree(core: GatewayCore, workspace: ui.Workspace, attempt: WorktreeAttempt) {
  const { row } = await createWorktree(
    core,
    create(ui.CreateThreadRequestSchema, {
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      baseRef: attempt.head,
    }),
    undefined,
    { id: attempt.id, commandId: attempt.commandId, branch: attempt.branch, expectedRoot: workspace.rootPath },
  );

  return row;
}

/**
 * Removes what one attempt created, also when its answer was lost: an attempt without a row is replayed (the
 * worker answers with what it created, or refuses as it did then) and whatever it returns is removed.
 */
export async function removeAttempt(core: GatewayCore, workspaceId: string, attempt: WorktreeAttempt) {
  if (await removeTargetWorktree(core, attempt.id)) return;

  const workspace = (await coreRun(core, (s) => s.listProjects(core[coreState].options.userId)))
    .flatMap((p) => p.workspaces)
    .find((w) => w.id === workspaceId);

  if (!workspace) return;

  try {
    await attemptWorktree(core, workspace, attempt);
  } catch (error) {
    // The worker refused it then and now (a run it did not finish is answered from its intent): nothing to remove.
    // Anything else (offline, Git could not tell) is tried again later.
    if (error instanceof WorkerQueryError && DEFINITE_REFUSALS.has(error.code)) return;
    throw error;
  }

  await removeTargetWorktree(core, attempt.id);
}

/**
 * What a move that did not commit left on both workers: the target's staging, adopted sessions and worktrees, the
 * source's package. Runs only after the decision to abort is durable; true when everything is gone (otherwise the
 * gateway tries again later).
 */
export async function cleanUpTransfer(core: GatewayCore, row: TransferRow): Promise<boolean> {
  const done = (work: Promise<object | void>) =>
    work.then(
      () => true,
      () => false,
    );

  const results = [
    await done(transferOperation(core, row.target_worker_id, { action: { case: "cancel", value: row.id } })),
    await done(transferOperation(core, row.source_worker_id, { action: { case: "release", value: row.id } })),
  ];

  for (const attempt of row.worktree_attempts)
    results.push(await done(removeAttempt(core, row.target_workspace_id, attempt)));

  return results.every(Boolean);
}

/** Removes a worktree of the move; false when it has no row (never recorded). Throws while it can't be removed. */
export async function removeTargetWorktree(core: GatewayCore, worktreeId: string): Promise<boolean> {
  const rows = await coreRun(core, (s) =>
    s.worktreeInventory(core[coreState].options.userId, "", "", worktreeId),
  ).catch((error: Error) => {
    if (error instanceof NotFound) return [];
    throw error;
  });

  const worktree = rows[0];

  if (!worktree) return false;
  const { entry, settings } = await scanEntry(core, worktree, true);

  if (entry.removed) return true;

  if (!entry.status || entry.detail) throw new InvalidError(entry.detail || "The worktree can't be removed yet.");
  await removeEntry(core, worktree, entry.status, settings, true, entry.status.headCommit);

  return true;
}
