import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { NoticeLevel, ThreadEventSchema } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { insertEvent } from "../store/ingest-events.ts";
import { Invalid } from "../store/errors.ts";
import { familyBlocker } from "./fences.ts";
import type { WorktreeAttempt } from "./runner.ts";

/** Durable records of thread transfers between workers of this gateway (docs/thread-transfers.md). */

type Sql = SqlClient.SqlClient;

export interface SessionPlan {
  threadId: string;
  provider: string;
  providerThreadId: string;
  sourceProfileId: string;
  targetProfileId: string;
}

export interface TransferRow {
  owner_user_id: string;
  id: string;
  thread_id: string;
  family: string[];
  source_worker_id: string;
  target_worker_id: string;
  source_workspace_id: string;
  target_workspace_id: string;
  source_cwd: string;
  source_worktree_id: string | null;
  target_cwd: string | null;
  target_worktree_id: string | null;
  worktree_attempts: WorktreeAttempt[];
  sessions: SessionPlan[];
  local_files: string[];
  expected_head: string;
  branch: string;
  state: "preparing" | "prepared" | "committed" | "done" | "aborted";
  phase: string;
  bytes: string;
  total_bytes: string;
  error: string;
  frozen_schedules: { id: string; status: string; next_run_at: string | null }[];
  cleanup_pending: boolean;
  created_at: Date;
}

/** The main thread and its side threads, all in the main thread's folder; or why they can't move together. */
export function familyOf(sql: Sql, owner: string, threadId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{
      id: string;
      kind: string;
      cwd: string | null;
      worktree_id: string | null;
      root_thread_id: string;
      worker_id: string | null;
      workspace_id: string | null;
      provider: string;
      provider_profile_id: string | null;
      provider_thread_id: string | null;
    }>(
      `SELECT t.id, t.kind, t.cwd, t.worktree_id, t.root_thread_id, t.worker_id, t.workspace_id, t.provider,
        t.provider_profile_id, t.provider_thread_id
      FROM threads t JOIN threads main ON main.id = $1::uuid AND t.root_thread_id = main.root_thread_id
      WHERE main.owner_user_id = $2::uuid AND t.owner_user_id = $2::uuid AND t.deleted_at IS NULL
      ORDER BY t.depth, t.id`,
      [threadId, owner],
    );

    const main = rows.find((r) => r.id === threadId);

    if (!main) return yield* Effect.fail(new Invalid("thread not found"));

    if (main.kind !== "main")
      return yield* Effect.fail(new Invalid("Move the main thread; its side threads go with it."));

    if (rows.some((r) => r.cwd !== main.cwd || r.worktree_id !== main.worktree_id || r.worker_id !== main.worker_id))
      return yield* Effect.fail(new Invalid("Side threads in other folders can't move with this thread yet."));

    return { main, family: rows };
  });
}

/** Freezes the family and records the transfer; refuses when it is busy. */
export function freezeTransfer(
  input: Omit<
    TransferRow,
    | "state"
    | "phase"
    | "bytes"
    | "total_bytes"
    | "error"
    | "frozen_schedules"
    | "created_at"
    | "target_cwd"
    | "target_worktree_id"
    | "worktree_attempts"
    | "cleanup_pending"
  >,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // The main thread first: a side thread joins under its parent's lock, so after this the family is fixed.
        yield* sql.unsafe(`SELECT id FROM threads WHERE id = $1::uuid FOR UPDATE`, [input.thread_id]);
        yield* sql.unsafe(
          `SELECT id FROM threads WHERE root_thread_id = $1::uuid AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
          [input.thread_id],
        );
        const blocked = yield* familyBlocker(sql, input.owner_user_id, input.family);

        if (blocked) return yield* Effect.fail(new Invalid(blocked));

        if (!(yield* samePlan(sql, input)))
          return yield* Effect.fail(new Invalid("The thread changed. Review the move again."));

        const schedules = yield* sql.unsafe<{ id: string; status: string; next_run_at: string | null }>(
          `SELECT id, status, next_run_at FROM schedules WHERE thread_id = ANY($1::uuid[]) AND status IN ('active','paused')
          ORDER BY id FOR UPDATE`,
          [input.family],
        );

        yield* sql.unsafe(
          `UPDATE schedules SET status = 'paused', next_run_at = NULL, lease_owner = NULL, lease_until = NULL,
          updated_at = now() WHERE id = ANY($1::uuid[])`,
          [schedules.map((s) => s.id)],
        );
        yield* sql.unsafe(
          `INSERT INTO thread_transfers(owner_user_id,id,thread_id,family,source_worker_id,target_worker_id,
            source_workspace_id,target_workspace_id,source_cwd,source_worktree_id,sessions,local_files,expected_head,
            branch,state,phase,frozen_schedules)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid[],$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10::uuid,$11::jsonb,
            $12::jsonb,$13,$14,'preparing','freezing',$15::jsonb)`,
          [
            input.owner_user_id,
            input.id,
            input.thread_id,
            input.family,
            input.source_worker_id,
            input.target_worker_id,
            input.source_workspace_id,
            input.target_workspace_id,
            input.source_cwd,
            input.source_worktree_id,
            JSON.stringify(input.sessions),
            JSON.stringify(input.local_files),
            input.expected_head,
            input.branch,
            JSON.stringify(schedules),
          ],
        );
        yield* sql.unsafe(`UPDATE threads SET transfer_pending_id = $2::uuid WHERE id = ANY($1::uuid[])`, [
          input.family,
          input.id,
        ]);
      }),
    );
  });
}

/** Read again under the family's locks: the same threads, in the same folder, with the same sessions. */
function samePlan(
  sql: Sql,
  input: Pick<
    TransferRow,
    "owner_user_id" | "thread_id" | "family" | "sessions" | "source_worker_id" | "source_cwd" | "source_worktree_id"
  >,
) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{
      id: string;
      worker_id: string | null;
      cwd: string | null;
      worktree_id: string | null;
      provider: string;
      provider_profile_id: string | null;
      provider_thread_id: string | null;
    }>(
      `SELECT id, worker_id, cwd, worktree_id, provider, provider_profile_id, provider_thread_id FROM threads
      WHERE root_thread_id = $1::uuid AND owner_user_id = $2::uuid AND deleted_at IS NULL`,
      [input.thread_id, input.owner_user_id],
    );

    return (
      rows.some((r) => r.id === input.thread_id) &&
      rows.length === input.family.length &&
      rows.every((r) => {
        const plan = input.sessions.find((p) => p.threadId === r.id);

        return (
          plan !== undefined &&
          r.worker_id === input.source_worker_id &&
          r.cwd === input.source_cwd &&
          r.worktree_id === input.source_worktree_id &&
          r.provider === plan.provider &&
          r.provider_thread_id === plan.providerThreadId &&
          (r.provider_profile_id ?? "") === plan.sourceProfileId
        );
      })
    );
  });
}

const COLUMNS = `owner_user_id, id, thread_id, family, source_worker_id, target_worker_id, source_workspace_id,
  target_workspace_id, source_cwd, source_worktree_id, target_cwd, target_worktree_id, worktree_attempts,
  sessions, local_files, expected_head, branch, state, phase, bytes::text, total_bytes::text, error, frozen_schedules,
  cleanup_pending, created_at`;

export function loadTransfer(owner: string, id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql.unsafe<TransferRow>(
      `SELECT ${COLUMNS} FROM thread_transfers WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
      [owner, id],
    );

    return row;
  });
}

/** Transfers a restart interrupted: preparing ones roll back, committed ones finish, aborted ones finish cleaning up. */
export function unfinishedTransfers(owner: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.unsafe<TransferRow>(
      `SELECT ${COLUMNS} FROM thread_transfers WHERE owner_user_id = $1::uuid
        AND (state IN ('preparing','prepared','committed') OR (state = 'aborted' AND cleanup_pending))`,
      [owner],
    );
  });
}

/** A worktree the move is about to create on the target. */
export function reserveTargetWorktree(id: string, attempt: WorktreeAttempt) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `UPDATE thread_transfers SET worktree_attempts = worktree_attempts || $2::jsonb, updated_at = now()
      WHERE id = $1::uuid AND state = 'preparing'`,
      [id, JSON.stringify([attempt])],
    );
  });
}

export function cleanedUp(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`UPDATE thread_transfers SET cleanup_pending = false, updated_at = now() WHERE id = $1::uuid`, [
      id,
    ]);
  });
}

export function transferProgress(id: string, progress: { phase?: string; bytes?: bigint; totalBytes?: bigint }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `UPDATE thread_transfers SET phase = coalesce($2, phase), bytes = coalesce($3::bigint, bytes),
        total_bytes = coalesce($4::bigint, total_bytes), updated_at = now() WHERE id = $1::uuid AND state = 'preparing'`,
      [id, progress.phase ?? null, progress.bytes?.toString() ?? null, progress.totalBytes?.toString() ?? null],
    );
  });
}

export function preparedTransfer(id: string, target: { cwd: string; worktreeId: string }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe(
      `UPDATE thread_transfers SET state = 'prepared', phase = 'switching', target_cwd = $2, target_worktree_id = $3::uuid,
        updated_at = now() WHERE id = $1::uuid AND state = 'preparing' RETURNING id`,
      [id, target.cwd, target.worktreeId],
    );

    if (!rows.length) return yield* Effect.fail(new Invalid("The move was cancelled."));
  });
}

export function recordTargetWorktree(id: string, cwd: string, worktreeId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `UPDATE thread_transfers SET target_cwd = $2, target_worktree_id = $3::uuid, updated_at = now()
      WHERE id = $1::uuid AND state = 'preparing'`,
      [id, cwd, worktreeId],
    );
  });
}

function restoreSchedules(sql: Sql, row: TransferRow) {
  return Effect.forEach(row.frozen_schedules, (s) =>
    sql.unsafe(
      `UPDATE schedules SET status = $2, next_run_at = $3, updated_at = now() WHERE id = $1::uuid AND status = 'paused'`,
      [s.id, s.status, s.next_run_at],
    ),
  );
}

/** Rolls back a transfer that did not commit: the family stays on its worker, as it was. */
export function abortTransfer(row: TransferRow, error: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [locked] = yield* sql.unsafe<{ state: string }>(
          `SELECT state FROM thread_transfers WHERE id = $1::uuid FOR UPDATE`,
          [row.id],
        );

        if (locked?.state !== "preparing" && locked?.state !== "prepared") return false;
        yield* sql.unsafe(
          `UPDATE threads SET transfer_pending_id = NULL WHERE id = ANY($1::uuid[]) AND transfer_pending_id = $2::uuid`,
          [row.family, row.id],
        );
        yield* restoreSchedules(sql, row);
        yield* sql.unsafe(
          `UPDATE thread_transfers SET state = 'aborted', error = $2, cleanup_pending = true, updated_at = now()
          WHERE id = $1::uuid`,
          [row.id, error.slice(0, 500)],
        );

        return true;
      }),
    );
  });
}

/**
 * The cut-over, in one transaction: the family's placement becomes the target's new worktree and instance, the
 * schedules resume and the next turn hears where the thread is now. Returns the stored notice events.
 */
export function commitTransfer(row: TransferRow, names: { from: string; to: string }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [locked] = yield* sql.unsafe<{ state: string }>(
          `SELECT state FROM thread_transfers WHERE id = $1::uuid FOR UPDATE`,
          [row.id],
        );

        if (locked?.state !== "prepared") return yield* Effect.fail(new Invalid("The move was cancelled."));
        yield* sql.unsafe(`SELECT set_config('canopy.thread_transfer', $1, true)`, [row.id]);
        const note = `[canopy] This thread moved from ${names.from} (${row.source_cwd}) to ${names.to} (${row.target_cwd}). Paths in earlier messages refer to the old folder; use the new one.`;

        for (const plan of row.sessions)
          yield* sql.unsafe(
            `UPDATE threads SET worker_id = $2::uuid, workspace_id = $3::uuid, cwd = $4, worktree_id = $5::uuid,
              provider_profile_id = nullif($6, ''), transfer_pending_id = NULL, last_seq = last_seq + 1,
              pull_request_revision = pull_request_revision + 1,
              settings = jsonb_set(settings, '{branchNote}', to_jsonb($7::text))
            WHERE id = $1::uuid AND transfer_pending_id = $8::uuid`,
            [
              plan.threadId,
              row.target_worker_id,
              row.target_workspace_id,
              row.target_cwd,
              row.target_worktree_id,
              plan.targetProfileId,
              note,
              row.id,
            ],
          );

        yield* restoreSchedules(sql, row);
        // Thread secrets are files on the old worker: the agent asks for them again there.
        yield* sql.unsafe(
          `UPDATE thread_secrets SET status = 'expired', ciphertext = NULL, key_id = NULL, file_path = NULL,
            revision = revision + 1 WHERE thread_id = ANY($1::uuid[]) AND status IN ('pending','saved')`,
          [row.family],
        );

        for (const id of row.family) {
          yield* sql.unsafe(
            `INSERT INTO github_git_contexts(owner_user_id,thread_id,context) VALUES($1::uuid,$2::uuid,'{}')`,
            [row.owner_user_id, id],
          );
        }

        yield* sql.unsafe(
          `UPDATE thread_transfers SET state = 'committed', phase = 'releasing', updated_at = now() WHERE id = $1::uuid`,
          [row.id],
        );

        return yield* notices(sql, row, names);
      }),
    );
  });
}

function notices(sql: Sql, row: TransferRow, names: { from: string; to: string }) {
  return Effect.gen(function* () {
    const stored = [];

    const seqs = yield* sql.unsafe<{ id: string; last_seq: string }>(
      `SELECT id, last_seq::text FROM threads WHERE id = ANY($1::uuid[])`,
      [row.family],
    );

    for (const thread of seqs) {
      const event = create(ThreadEventSchema, {
        eventId: Bun.randomUUIDv7(),
        threadId: thread.id,
        occurredAt: timestampNow(),
        body: {
          case: "notice",
          value: {
            level: NoticeLevel.INFO,
            code: "transferred",
            message: `Moved from ${names.from} to ${names.to}`,
            dataJson: JSON.stringify({ transfer_id: row.id }),
          },
        },
      });

      const seq = BigInt(thread.last_seq);
      yield* insertEvent(sql, thread.id, seq, event, "gateway");
      stored.push({ threadId: thread.id, seq, event });
    }

    return stored;
  });
}

export function finishTransfer(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `UPDATE thread_transfers SET state = 'done', phase = '', updated_at = now() WHERE id = $1::uuid AND state = 'committed'`,
      [id],
    );
  });
}
