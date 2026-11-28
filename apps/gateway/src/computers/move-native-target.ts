import { create } from "@bufbuild/protobuf";
import { computerLink, type computerLink as link, type ThreadTransferOperation } from "@canopy/contracts";
import { THREAD_TRANSFER_CAPABILITY } from "@canopy/domain/release/protocol";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { z } from "zod";
import { coreRun } from "../core/core-broadcast.ts";
import { newWorktree } from "../thread-transfers/runner.ts";
import { transferOperation } from "../thread-transfers/worker-io.ts";
import {
  dropMoveFiles,
  moveKey,
  RESERVATION_COLUMNS,
  reservation,
  serialized,
  type Reservation,
} from "./move-native-files.ts";
import { movesState } from "./moves-context.ts";
import { movesCore } from "./moves-recovery.ts";
import type { ComputerMoves } from "./moves.ts";

/**
 * Target of a linked-computer move with native continuation (docs/thread-transfers.md). A partner stages the thread's
 * session and files here step by step before PrepareMove. The reservation (move-native-files.ts) binds the move to
 * that partner, its workspace and worker; the worker token, the worktree it may use and the sessions PrepareMove may
 * claim all come from the reservation, never from the partner's request.
 */

const FILES_TIMEOUT_MS = 10 * 60_000;
const TOKEN = z.uuid();

/** Moves one partner may stage here at once. */
const MAX_RECEIVING = 4;

/** Steps a partner may run on this computer's worker. */
const STEPS = new Set(["tips", "prepare", "writeBatch", "stage", "apply"]);

const refuse = (message: string) => new ConnectError(message, Code.FailedPrecondition);

class SessionTaken extends Error {}

/** The partner names the move; this computer's worker knows it by the reservation's token. */
function withToken(operation: ThreadTransferOperation, moveId: string, token: string) {
  const action = operation.action;

  switch (action.case) {
    case "prepare":
    case "stage":
    case "apply":
      if (action.value.token !== moveId) throw refuse("The step belongs to another move.");
      action.value.token = token;
      break;
    case "writeBatch":
      if (action.value.token !== moveId || action.value.chunks.some((c) => c.token !== moveId))
        throw refuse("The step belongs to another move.");
      action.value.token = token;

      for (const chunk of action.value.chunks) chunk.token = token;
      break;
    default:
      break;
  }
}

/** The move's reservation for this partner and workspace, made on its first step (capacity checked per partner). */
async function reserve(hostContext: ComputerMoves, peer: string, moveId: string, workspaceId: string) {
  const existing = await reservation(hostContext, moveId);

  if (existing) {
    if (existing.peer_node_id !== peer || existing.workspace_id !== workspaceId)
      throw refuse("The step belongs to another move.");

    return existing;
  }

  return serialized(hostContext, `peer:${peer}`, async () => {
    const store = hostContext[movesState].store;
    const core = movesCore(hostContext);
    const projects = await coreRun(core, (s) => s.listProjects(store.owner));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === workspaceId);

    if (!workspace) throw refuse("The chosen workspace is not on this computer.");

    if (!core.link.connections.get(workspace.workerId)?.hello.capabilities.includes(THREAD_TRANSFER_CAPABILITY))
      throw refuse("Update the worker on this computer to continue moved threads.");

    const [busy] = await store.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM computer_move_files WHERE owner_user_id = $1::uuid AND peer_node_id = $2
        AND state IN ('receiving','applied','staged','dropping')`,
      [store.owner, peer],
    );

    if ((busy?.count ?? 0) >= MAX_RECEIVING) throw refuse("This computer is receiving other moves. Try again later.");

    const [made] = await store.query<Reservation>(
      `INSERT INTO computer_move_files(owner_user_id, move_id, peer_node_id, token, workspace_id, worker_id, state)
      VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, 'receiving') RETURNING ${RESERVATION_COLUMNS}`,
      [store.owner, moveId, peer, Bun.randomUUIDv7(), workspaceId, workspace.workerId],
    );

    // SAFETY: INSERT … RETURNING without a conflict clause returns the inserted row or throws.
    return made!;
  });
}

/** One request of a partner's move, serialized with everything else of that move. */
export async function serveMoveFiles(
  hostContext: ComputerMoves,
  peer: string,
  request: link.MoveFiles,
): Promise<link.MoveFilesReply> {
  if (!TOKEN.safeParse(request.moveId).success) throw refuse("Invalid move.");

  return serialized(hostContext, moveKey(request.moveId), () => moveFilesStep(hostContext, peer, request));
}

async function moveFilesStep(hostContext: ComputerMoves, peer: string, request: link.MoveFiles) {
  const store = hostContext[movesState].store;
  const core = movesCore(hostContext);

  const [staged] = await store.query<{ state: string }>(
    `SELECT state FROM computer_moves WHERE owner_user_id=$1::uuid AND id=$2::uuid AND role='target'`,
    [store.owner, request.moveId],
  );

  // A staged move's files follow its decision; the partner may only take back files of a move this computer refused.
  if (request.discard) {
    if (!staged || staged.state === "aborted") await dropMoveFiles(hostContext, request.moveId, peer);

    return create(computerLink.MoveFilesReplySchema);
  }

  if (staged) throw refuse("This move is already staged.");
  const row = await reserve(hostContext, peer, request.moveId, request.workspaceId);

  if (row.state !== "receiving") throw refuse("This move's files were already staged.");
  await store.query(`UPDATE computer_move_files SET updated_at = now() WHERE move_id = $1::uuid`, [row.move_id]);

  const workspace = (await coreRun(core, (s) => s.listProjects(store.owner)))
    .flatMap((p) => p.workspaces)
    .find((w) => w.id === row.workspace_id);

  if (!workspace) throw refuse("The chosen workspace is not on this computer.");

  if (request.checkoutHead) {
    if (row.worktree_id && row.worktree_path)
      return create(computerLink.MoveFilesReplySchema, {
        worktreeId: row.worktree_id,
        worktreePath: row.worktree_path,
      });

    const worktree = await newWorktree(
      core,
      row.token,
      workspace,
      request.checkoutHead,
      request.checkoutBranch,
      (attempt) =>
        store
          .query(
            `UPDATE computer_move_files SET worktree_attempts = worktree_attempts || $2::jsonb, updated_at = now()
            WHERE move_id = $1::uuid`,
            [row.move_id, JSON.stringify([attempt])],
          )
          .then(() => undefined),
    );

    await store.query(
      `UPDATE computer_move_files SET worktree_id = $2::uuid, worktree_path = $3, updated_at = now()
      WHERE move_id = $1::uuid`,
      [row.move_id, worktree.id, worktree.path],
    );

    return create(computerLink.MoveFilesReplySchema, { worktreeId: worktree.id, worktreePath: worktree.path });
  }

  const operation = request.operation;
  const action = operation?.action;

  if (!operation || !action?.case || !STEPS.has(action.case)) throw refuse("Unknown move step.");
  withToken(operation, row.move_id, row.token);

  // This computer's own workspace root and worktree: the partner does not choose paths here.
  if (action.case === "tips" || action.case === "stage") action.value.repoPath = workspace.rootPath;

  if (action.case === "apply") {
    if (!row.worktree_path || action.value.cwd !== row.worktree_path) throw refuse("The step names another folder.");
    await claimSessions(hostContext, row.move_id, action.value.sessions);
  }

  const result = await transferOperation(core, row.worker_id, operation, FILES_TIMEOUT_MS);

  // The worker's adoption receipt is the only list of sessions PrepareMove may claim.
  if (action.case === "apply") {
    const receipt = Object.fromEntries(
      result.adopted.map((s) => [
        s.threadId,
        { provider: s.provider, profileId: s.profileId, providerThreadId: s.providerThreadId },
      ]),
    );

    await store.query(
      `UPDATE computer_move_files SET state = 'applied', sessions = $2::jsonb, updated_at = now()
      WHERE move_id = $1::uuid AND state = 'receiving'`,
      [row.move_id, JSON.stringify(receipt)],
    );
  }

  return create(computerLink.MoveFilesReplySchema, { result });
}

/**
 * A session one thread here has (deleted ones too), or another move is adopting, can't be adopted again, and a move
 * can't bring one session twice. In one transaction the sessions are claimed first, then (a new snapshot) checked
 * against the threads, so a session is always either claimed or owned by a thread. Ids compare in lower case.
 */
async function claimSessions(
  hostContext: ComputerMoves,
  moveId: string,
  moved: readonly { providerThreadId: string }[],
) {
  const store = hostContext[movesState].store;
  const sessions = moved.map((s) => s.providerThreadId.toLowerCase());

  if (new Set(sessions).size !== sessions.length) throw refuse("The move brings one session twice.");

  const claim = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // One set of sessions per move: a retried apply names the same ones (they stay claimed until cleanup).
    const earlier = yield* sql.unsafe<{ provider_thread_id: string }>(
      `SELECT provider_thread_id FROM computer_move_file_sessions WHERE owner_user_id = $1::uuid AND move_id = $2::uuid`,
      [store.owner, moveId],
    );

    if (
      earlier.length &&
      (earlier.length !== sessions.length || earlier.some((e) => !sessions.includes(e.provider_thread_id)))
    )
      return yield* Effect.fail(new SessionTaken("The step names other sessions than before."));

    const claimed = yield* sql.unsafe(
      `INSERT INTO computer_move_file_sessions(owner_user_id, move_id, provider_thread_id)
      SELECT $1::uuid, $2::uuid, s FROM unnest($3::text[]) s
      ON CONFLICT (owner_user_id, provider_thread_id) DO UPDATE SET move_id = EXCLUDED.move_id
        WHERE computer_move_file_sessions.move_id = EXCLUDED.move_id
      RETURNING provider_thread_id`,
      [store.owner, moveId, sessions],
    );

    if (claimed.length !== sessions.length)
      return yield* Effect.fail(new SessionTaken("Another move is bringing this session here."));

    const owned = yield* sql.unsafe(
      `SELECT 1 FROM threads WHERE owner_user_id = $1::uuid AND lower(provider_thread_id) = ANY($2::text[]) LIMIT 1`,
      [store.owner, sessions],
    );

    if (owned.length)
      return yield* Effect.fail(new SessionTaken("A thread on this computer already continues this session."));
  });

  // A refusal rolls the claims back.
  const refusal = await store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(claim).pipe(
        Effect.as(""),
        Effect.catch((error) =>
          Effect.succeed(error instanceof SessionTaken ? error.message : "The move's sessions could not be checked."),
        ),
      );
    }),
  );

  if (refusal) throw refuse(refusal);
}

/**
 * PrepareMove's check, within the move's serialized work: the partner staged exactly these threads' sessions here
 * (the worker's receipt, with their harness and instance) in its worktree of the chosen workspace. The reservation
 * then belongs to the staged move and only its decision removes the files.
 */
export async function nativePlacement(
  hostContext: ComputerMoves,
  peer: string,
  prepare: link.MovePrepare,
  threads: readonly { id: string; provider: string; provider_profile_id: string | null }[],
) {
  const native = prepare.native;
  const row = native && (await reservation(hostContext, prepare.moveId));

  const fits =
    native &&
    row?.peer_node_id === peer &&
    row.state === "applied" &&
    row.workspace_id === prepare.workspaceId &&
    row.worktree_id === native.worktreeId &&
    row.worktree_path === native.cwd &&
    Object.keys(row.sessions).length === threads.length &&
    Object.keys(native.sessions).length === threads.length &&
    threads.every((t) => {
      const adopted = row.sessions[t.id];

      return (
        adopted !== undefined &&
        adopted.providerThreadId === native.sessions[t.id] &&
        adopted.provider === t.provider &&
        adopted.profileId === (t.provider_profile_id ?? "")
      );
    });

  if (!fits) return false;
  const store = hostContext[movesState].store;

  // The worktree is still there (a move's reserved worktree is busy for cleanup until the thread owns it).
  const tree = await store.query(
    `SELECT 1 FROM worktrees WHERE id = $1::uuid AND owner_user_id = $2::uuid AND workspace_id = $3::uuid
      AND removed_at IS NULL AND removal_token IS NULL`,
    [native.worktreeId, store.owner, prepare.workspaceId],
  );

  if (!tree.length) return false;

  const staged = await store.query(
    `UPDATE computer_move_files SET state = 'staged', updated_at = now()
    WHERE owner_user_id = $1::uuid AND move_id = $2::uuid AND state = 'applied' RETURNING move_id`,
    [store.owner, prepare.moveId],
  );

  return staged.length > 0;
}
