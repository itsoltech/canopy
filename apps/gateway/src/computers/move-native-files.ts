import { removeAttempt, type WorktreeAttempt } from "../thread-transfers/runner.ts";
import { transferOperation } from "../thread-transfers/worker-io.ts";
import { movesState } from "./moves-context.ts";
import { movesCore } from "./moves-recovery.ts";
import type { ComputerMoves } from "./moves.ts";

/**
 * Target-side record of a linked-computer move's session and files (docs/thread-transfers.md): one reservation per
 * move, bound to the partner that started it. Everything for one move runs serialized (`serialized`), so a discard,
 * a step, PrepareMove and the decision never interleave; cleanup follows the durable decision.
 */

/** A reservation no partner touched for this long, without a staged move, is dropped. */
const ABANDONED_MS = 60 * 60_000;

export interface MoveSession {
  provider: string;
  profileId: string;
  providerThreadId: string;
}

export interface Reservation {
  move_id: string;
  peer_node_id: string;
  token: string;
  workspace_id: string;
  worker_id: string;
  worktree_attempts: WorktreeAttempt[];
  worktree_id: string | null;
  worktree_path: string | null;
  sessions: Record<string, MoveSession>;
  state: "receiving" | "applied" | "staged" | "kept" | "dropping" | "done";
}

export const RESERVATION_COLUMNS = `move_id, peer_node_id, token, workspace_id, worker_id, worktree_attempts,
  worktree_id, worktree_path, sessions, state`;

const queues = new WeakMap<ComputerMoves, Map<string, Promise<void>>>();

/** Runs `work` after every earlier work on `key` (one gateway process owns its database). Never nest one key. */
export function serialized<T>(hostContext: ComputerMoves, key: string, work: () => Promise<T>): Promise<T> {
  const map = queues.get(hostContext) ?? new Map<string, Promise<void>>();
  queues.set(hostContext, map);
  const run = (map.get(key) ?? Promise.resolve()).then(work);

  const settled = run.then(
    () => undefined,
    () => undefined,
  );

  map.set(key, settled);
  void settled.then(() => {
    if (map.get(key) === settled) map.delete(key);
  });

  return run;
}

/** One key per move however its id is spelled. */
export const moveKey = (moveId: string) => `move:${moveId.toLowerCase()}`;

export async function reservation(hostContext: ComputerMoves, moveId: string) {
  const store = hostContext[movesState].store;

  const [row] = await store.query<Reservation>(
    `SELECT ${RESERVATION_COLUMNS} FROM computer_move_files WHERE owner_user_id = $1::uuid AND move_id = $2::uuid`,
    [store.owner, moveId],
  );

  return row;
}

/** Done, and the session claims go with it, in one statement. */
async function finish(hostContext: ComputerMoves, moveId: string) {
  const store = hostContext[movesState].store;
  await store.query(
    `WITH claims AS (DELETE FROM computer_move_file_sessions WHERE owner_user_id = $1::uuid AND move_id = $2::uuid)
    UPDATE computer_move_files SET state = 'done', updated_at = now() WHERE owner_user_id = $1::uuid AND move_id = $2::uuid`,
    [store.owner, moveId],
  );
}

/**
 * A move that will not happen: its staging, adopted sessions and worktrees go. `peer`, when given, must be the
 * partner the move belongs to. Call within the move's `serialized` work.
 */
export async function dropMoveFiles(hostContext: ComputerMoves, moveId: string, peer?: string) {
  const store = hostContext[movesState].store;
  const core = movesCore(hostContext);

  const [row] = await store.query<Reservation>(
    `UPDATE computer_move_files SET state = 'dropping', updated_at = now()
    WHERE owner_user_id = $1::uuid AND move_id = $2::uuid AND ($3::text IS NULL OR peer_node_id = $3)
      AND state IN ('receiving','applied','staged','dropping')
    RETURNING ${RESERVATION_COLUMNS}`,
    [store.owner, moveId, peer ?? null],
  );

  if (!row) return;

  const done = (work: Promise<object | void>) =>
    work.then(
      () => true,
      () => false,
    );

  const results = [
    await done(transferOperation(core, row.worker_id, { action: { case: "cancel", value: row.token } })),
  ];

  for (const attempt of row.worktree_attempts) results.push(await done(removeAttempt(core, row.workspace_id, attempt)));

  if (results.every(Boolean)) await finish(hostContext, moveId);
}

/** After the move committed: the sessions and worktree stay, the staging and fetched ref go. Within `serialized`. */
export async function keepMoveFiles(hostContext: ComputerMoves, moveId: string) {
  const store = hostContext[movesState].store;

  // Only once this partner's move is applied here: the new threads own the sessions and the worktree.
  const [row] = await store.query<Reservation>(
    `UPDATE computer_move_files f SET state = 'kept', updated_at = now()
    WHERE f.owner_user_id = $1::uuid AND f.move_id = $2::uuid AND f.state IN ('staged','kept')
      AND EXISTS (SELECT 1 FROM computer_moves m WHERE m.owner_user_id = f.owner_user_id AND m.id = f.move_id
        AND m.role = 'target' AND m.peer_node_id = f.peer_node_id AND m.state = 'done')
    RETURNING ${RESERVATION_COLUMNS.split(",")
      .map((c) => `f.${c.trim()}`)
      .join(", ")}`,
    [store.owner, moveId],
  );

  if (!row) return;

  const released = await transferOperation(movesCore(hostContext), row.worker_id, {
    action: { case: "release", value: row.token },
  }).then(
    () => true,
    () => false,
  );

  if (released) await finish(hostContext, moveId);
}

/**
 * Finishes what reservations still hold, driven by the move's decision here: a committed move keeps the files, an
 * aborted one drops them, and one never staged (or refused) goes after an hour without a step. Heartbeat.
 */
export async function sweepMoveFiles(hostContext: ComputerMoves) {
  const store = hostContext[movesState].store;

  const open = await store.query<{ move_id: string }>(
    `SELECT move_id FROM computer_move_files WHERE owner_user_id = $1::uuid AND state <> 'done'`,
    [store.owner],
  );

  for (const { move_id: moveId } of open)
    await serialized(hostContext, moveKey(moveId), async () => {
      // Read inside the move's serialized work: a decision or PrepareMove can't slip in between.
      const [row] = await store.query<{ state: string; move_state: string | null; idle: boolean }>(
        `SELECT f.state, m.state AS move_state, f.updated_at < now() - make_interval(secs => $3) AS idle
        FROM computer_move_files f
        LEFT JOIN computer_moves m ON m.owner_user_id = f.owner_user_id AND m.id = f.move_id AND m.role = 'target'
          AND m.peer_node_id = f.peer_node_id
        WHERE f.owner_user_id = $1::uuid AND f.move_id = $2::uuid`,
        [store.owner, moveId, ABANDONED_MS / 1000],
      );

      if (!row || row.state === "done") return;

      if (row.move_state === "done") await keepMoveFiles(hostContext, moveId);
      else if (row.state === "dropping" || row.move_state === "aborted" || (!row.move_state && row.idle))
        await dropMoveFiles(hostContext, moveId);
    });
}
