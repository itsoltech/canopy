import type { PrChecksNote } from "@canopy/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { queryMethods } from "../diagnostics/query-context.ts";
import {
  deliverCheckNotes,
  pendingCheckNoteThreads,
  releaseCheckNotes,
  type CheckNoteDelivery,
} from "./pr-check-notes.ts";

/**
 * CI check watches of pull requests linked to a thread (docs/agent-bus.md, "Checki CI"). core/pr-check-watches.ts
 * polls the active ones and judges their checks; this keeps their progress and their notes (pr-check-notes.ts).
 */

export interface PrCheckWatchRow {
  id: string;
  owner_user_id: string;
  thread_id: string;
  pull_request_id: string;
  call_id: string;
  notify_on: string[];
  hops: number;
  status: "active" | "ended";
  end_reason: string | null;
  expires_at: Date;
  head_sha: string;
  head_seen_at: Date;
  head_changes: number;
  head_changed: boolean;
  seen: Record<string, string>;
  settled: boolean;
  created_at: Date;
  ended_at: Date | null;
  /** Joined: the pull request. */
  repository_name: string;
  number: number;
  /** Joined: still linked to the thread, and the thread neither archived nor deleted. */
  linked: boolean;
  thread_open: boolean;
}

export interface NewWatch {
  readonly id: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly pullRequestId: string;
  readonly callId: string;
  readonly notifyOn: readonly string[];
  readonly hops: number;
  readonly expiresAt: Date;
  readonly headSha: string;
  readonly seen: Record<string, string>;
  readonly settled: boolean;
}

export interface WatchProgress {
  readonly headSha: string;
  readonly headSeenAt: Date;
  readonly headChanges: number;
  readonly headChanged: boolean;
  readonly seen: Record<string, string>;
  readonly settled: boolean;
}

/** A note to store with the watch's progress; `end` ends the watch in the same transaction. */
export interface WatchNote {
  readonly body: PrChecksNote;
  readonly wake: boolean;
  readonly hops: number;
  readonly end?: string;
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError>;

const SELECT = `
  SELECT w.*, p.repository_name, p.number,
         EXISTS (SELECT 1 FROM thread_pull_requests l WHERE l.owner_user_id = w.owner_user_id AND l.thread_id = w.thread_id
                   AND l.pull_request_id = w.pull_request_id AND l.unlinked_at IS NULL) AS linked,
         (t.archived_at IS NULL AND t.deleted_at IS NULL) AS thread_open
    FROM pr_check_watches w
    JOIN github_pull_requests p ON p.owner_user_id = w.owner_user_id AND p.id = w.pull_request_id
    JOIN threads t ON t.id = w.thread_id`;

export class PrCheckWatchStore extends Context.Service<
  PrCheckWatchStore,
  {
    /** Stores a watch once per call (a re-sent call gets the first one) and ends the thread's earlier watch of the PR. */
    create(watch: NewWatch): Fx<PrCheckWatchRow>;
    byCall(callId: string): Fx<PrCheckWatchRow | undefined>;
    /** Active watches of the owner's threads, oldest first. */
    active(ownerUserId: string): Fx<readonly PrCheckWatchRow[]>;
    activeCount(threadId: string): Fx<number>;
    /** The thread's watches: active ones and those that ended in the last day, newest first. */
    ofThread(threadId: string, limit: number): Fx<readonly PrCheckWatchRow[]>;
    progress(id: string, progress: WatchProgress): Fx<void>;
    /** Stores a note (and the progress that led to it); the next delivery hands it to the agent. */
    note(id: string, progress: WatchProgress, note: WatchNote): Fx<void>;
    /** Ends a watch without a note; `cancelNotes` drops what still waits for delivery. */
    end(id: string, reason: string, cancelNotes: boolean): Fx<void>;
    /** The agent stops a watch of its own thread; undefined when the thread has no such watch. */
    cancel(threadId: string, watchId: string): Fx<PrCheckWatchRow | undefined>;
    deliver(threadId: string): Fx<CheckNoteDelivery>;
    pendingThreads(): Fx<string[]>;
    /** A note steer that did not join its turn: its notes wait again. False when none were its. */
    release(steerId: string): Fx<boolean>;
  }
>()("canopy/gateway/PrCheckWatchStore") {
  static readonly layer = Layer.effect(
    PrCheckWatchStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const byCall = (callId: string) =>
        sql
          .unsafe<PrCheckWatchRow>(`${SELECT} WHERE w.call_id = $1::uuid`, [callId])
          .pipe(Effect.map((rows) => rows[0]));

      const progress = (id: string, p: WatchProgress) => sql`
        UPDATE pr_check_watches SET head_sha = ${p.headSha}, head_seen_at = ${p.headSeenAt}, head_changes = ${p.headChanges},
               head_changed = ${p.headChanged}, seen = ${JSON.stringify(p.seen)}::jsonb, settled = ${p.settled}, updated_at = now()
         WHERE id = ${id}::uuid AND status = 'active'`;

      const end = (id: string, reason: string, cancelNotes: boolean) =>
        Effect.gen(function* () {
          yield* sql`UPDATE pr_check_watches SET status = 'ended', end_reason = ${reason}, ended_at = now(), updated_at = now()
                      WHERE id = ${id}::uuid AND status = 'active'`;

          if (cancelNotes)
            yield* sql`UPDATE pr_check_notes SET status = 'cancelled', reason = ${`watch ${reason}`}, updated_at = now()
                        WHERE watch_id = ${id}::uuid AND status = 'waiting'`;
        });

      const store: PrCheckWatchStore["Service"] = {
        create: (w) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* byCall(w.callId);

              if (existing) return existing;

              const earlier = yield* sql<{ id: string }>`
                SELECT id FROM pr_check_watches WHERE thread_id = ${w.threadId}::uuid
                   AND pull_request_id = ${w.pullRequestId}::uuid AND status = 'active' FOR UPDATE`;

              for (const row of earlier) yield* end(row.id, "replaced", true);
              yield* sql`
                INSERT INTO pr_check_watches (id, owner_user_id, thread_id, pull_request_id, call_id, notify_on, hops,
                                              expires_at, head_sha, seen, settled)
                VALUES (${w.id}::uuid, ${w.ownerUserId}::uuid, ${w.threadId}::uuid, ${w.pullRequestId}::uuid, ${w.callId}::uuid,
                        ${[...w.notifyOn]}::text[], ${w.hops}, ${w.expiresAt}, ${w.headSha}, ${JSON.stringify(w.seen)}::jsonb,
                        ${w.settled})`;

              // SAFETY: the row was inserted above in this transaction.
              return (yield* byCall(w.callId))!;
            }),
          ),

        byCall,

        active: (owner) =>
          sql.unsafe<PrCheckWatchRow>(
            `${SELECT} WHERE w.owner_user_id = $1::uuid AND w.status = 'active' ORDER BY w.created_at, w.id`,
            [owner],
          ),

        activeCount: (threadId) =>
          sql<{ count: number }>`
            SELECT count(*)::int AS count FROM pr_check_watches WHERE thread_id = ${threadId}::uuid AND status = 'active'`.pipe(
            Effect.map((rows) => rows[0]?.count ?? 0),
          ),

        ofThread: (threadId, limit) =>
          sql.unsafe<PrCheckWatchRow>(
            `${SELECT} WHERE w.thread_id = $1::uuid AND (w.status = 'active' OR w.ended_at > now() - interval '1 day')
              ORDER BY w.created_at DESC LIMIT $2`,
            [threadId, limit],
          ),

        progress: (id, p) => progress(id, p).pipe(Effect.asVoid),

        note: (id, p, note) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const active = yield* sql<{ thread_id: string }>`
                SELECT thread_id FROM pr_check_watches WHERE id = ${id}::uuid AND status = 'active' FOR UPDATE`;

              if (!active[0]) return;
              yield* progress(id, { ...p, headChanged: false });
              yield* sql`
                INSERT INTO pr_check_notes (id, watch_id, thread_id, body, wake, hops)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${id}::uuid, ${active[0].thread_id}::uuid, ${JSON.stringify(note.body)}::jsonb,
                        ${note.wake}, ${note.hops})`;

              if (note.end) yield* end(id, note.end, false);
            }),
          ),

        end: (id, reason, cancelNotes) => sql.withTransaction(end(id, reason, cancelNotes)),

        cancel: (threadId, watchId) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{ id: string }>`
                SELECT id FROM pr_check_watches WHERE id = ${watchId}::uuid AND thread_id = ${threadId}::uuid FOR UPDATE`;

              if (!rows[0]) return undefined;
              yield* end(watchId, "cancelled", true);

              return (yield* sql.unsafe<PrCheckWatchRow>(`${SELECT} WHERE w.id = $1::uuid`, [watchId]))[0];
            }),
          ),

        deliver: (threadId) => deliverCheckNotes(sql, threadId),
        pendingThreads: () => pendingCheckNoteThreads(sql),
        release: (steerId) => releaseCheckNotes(sql, steerId),
      };

      // Platform notes for agents share the background notes' query family.
      return PrCheckWatchStore.of(queryMethods("background.store", store));
    }),
  );
}
