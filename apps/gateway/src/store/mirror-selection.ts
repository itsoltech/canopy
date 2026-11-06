import { MIRROR_CURSOR } from "@canopy/domain/thread-mirror";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export interface MirrorSelection {
  itemIds: string[];
  turnIds: string[];
  noticeSeqs: string[];
}

/** Called inside the snapshot's repeatable-read transaction, on the existing owner journal. */
export function mirrorSelection(sql: SqlClient.SqlClient, owner: string, thread: string, cursor: string) {
  return Effect.gen(function* () {
    const match = MIRROR_CURSOR.exec(cursor);

    if (!match) return undefined;

    const clock = (yield* sql<{ epoch: string; revision: string }>`SELECT epoch,revision::text
      FROM computer_thread_clock WHERE owner_user_id=${owner}::uuid`)[0];

    if (!clock || clock.epoch !== match[1] || BigInt(clock.revision) < BigInt(match[2]!)) return undefined;

    const changes = yield* sql<{
      revision: string;
      thread_id: string | null;
      entity_kind: string | null;
      entity_id: string | null;
    }>`
      SELECT revision::text,thread_id,entity_kind,entity_id FROM computer_thread_changes
      WHERE owner_user_id=${owner}::uuid AND revision>${match[2]!}::bigint AND revision<=${clock.revision}::bigint`;

    if (BigInt(changes.length) !== BigInt(clock.revision) - BigInt(match[2]!)) return undefined;

    const inherited = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM thread_fork_chain(${thread}::uuid) WHERE level>0`;

    const sources = new Set(inherited.map((row) => row.thread_id));

    if (changes.some((c) => c.thread_id && sources.has(c.thread_id))) return undefined;
    const moved = yield* sql`SELECT thread_id FROM computer_moved_threads WHERE thread_id=${thread}::uuid`;

    if (moved.length) return undefined;

    // These turns join mutable source records outside their own journal keys.
    const sourced = yield* sql`SELECT id FROM turns WHERE thread_id=ANY(${[thread, ...sources]}::uuid[]) AND
      (agent_call_id IS NOT NULL OR interaction_request_id IS NOT NULL OR schedule_id IS NOT NULL
        OR bot_call_id IS NOT NULL OR trigger='background_task') LIMIT 1`;

    if (sourced.length) return undefined;
    const own = changes.filter((c) => c.thread_id === thread);

    if (own.some((c) => !c.entity_kind || c.entity_kind === "history_reset")) return undefined;

    const keys = (kind: string) => [
      ...new Set(own.flatMap((c) => (c.entity_kind === kind && c.entity_id ? [c.entity_id] : []))),
    ];

    return {
      itemIds: keys("thread_items"),
      turnIds: keys("turns"),
      noticeSeqs: keys("thread_events"),
    } satisfies MirrorSelection;
  });
}
