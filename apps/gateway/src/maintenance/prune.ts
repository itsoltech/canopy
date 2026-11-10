import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pruneGitHubCache } from "../github/prune-cache.ts";

const BATCH = 256;

/** All eligibility decisions use durable facts. No user timeline or deduplication key is deleted. */
export const pruneDatabase = (owner: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO database_maintenance(owner_user_id) VALUES(${owner}::uuid) ON CONFLICT DO NOTHING`;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET LOCAL lock_timeout='100ms'`;
        yield* sql`SET LOCAL statement_timeout='1000ms'`;

        const claimed = yield* sql`SELECT owner_user_id FROM database_maintenance
      WHERE owner_user_id=${owner}::uuid AND next_run_at<=now() FOR UPDATE SKIP LOCKED`;

        if (!claimed.length) return 0;
        let touched = 0;
        touched += yield* pruneGitHubCache(sql, owner);

        touched += (yield* sql`DELETE FROM github_device_auth WHERE id IN (
          SELECT id FROM github_device_auth WHERE owner_user_id=${owner}::uuid AND expires_at<now()-interval '24 hours'
          ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING id`).length;

        touched += (yield* sql`DELETE FROM computer_thread_changes WHERE (owner_user_id,revision) IN (
      SELECT c.owner_user_id,c.revision FROM computer_thread_changes c JOIN computer_thread_clock h USING(owner_user_id)
      WHERE c.owner_user_id=${owner}::uuid AND c.revision<=h.revision-10000
      ORDER BY c.revision LIMIT ${BATCH} FOR UPDATE OF c SKIP LOCKED) RETURNING revision`).length;

        // Keep command IDs/status/result forever: queue gates, receipts and one-start constraints still use them.
        touched += (yield* sql`UPDATE worker_commands SET payload=''::bytea,payload_pruned_at=now() WHERE id IN (
      SELECT c.id FROM worker_commands c JOIN threads t ON t.id=c.thread_id
      WHERE t.owner_user_id=${owner}::uuid AND c.payload_pruned_at IS NULL
        AND c.status IN ('completed','failed') AND c.completed_at<now()-interval '7 days'
        AND NOT EXISTS(SELECT 1 FROM bot_harness_turns h WHERE h.command_id=c.id)
      ORDER BY c.completed_at,c.id LIMIT ${BATCH} FOR UPDATE OF c SKIP LOCKED) RETURNING id`).length;

        touched += yield* pruneHarness(sql, owner);
        touched += yield* pruneMirror(sql, owner);
        touched += (yield* sql`DELETE FROM config_history WHERE id IN (
      SELECT id FROM config_history WHERE owner_user_id=${owner}::uuid AND superseded_at<now()-interval '90 days'
      ORDER BY superseded_at,id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING id`).length;
        touched += (yield* sql`DELETE FROM connector_oauth_states WHERE state_hash IN (
      SELECT state_hash FROM connector_oauth_states WHERE owner_user_id=${owner}::uuid AND expires_at<now()-interval '7 days'
      ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING state_hash`).length;
        touched += (yield* sql`DELETE FROM agent_skill_source_previews WHERE id IN (
      SELECT id FROM agent_skill_source_previews WHERE owner_user_id=${owner}::uuid AND expires_at<now()
      ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING id`).length;
        yield* sql`UPDATE database_maintenance SET next_run_at=now()+make_interval(secs=>${touched ? 1 : 60})
      WHERE owner_user_id=${owner}::uuid`;

        return touched;
      }),
    );
  });

const pruneHarness = (sql: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    // Lock the same terminal harness row as ingestion. A replay cannot race removal or alter its projection.
    const rows = yield* sql<{ turn_id: string }>`SELECT h.turn_id FROM bot_harness_turns h JOIN bots b ON b.id=h.bot_id
    WHERE b.owner_user_id=${owner}::uuid AND h.outcome IS NOT NULL AND h.finished_at<now()-interval '7 days'
      AND h.events_pruned_at IS NULL
      AND (NOT EXISTS(SELECT 1 FROM bot_harness_events e WHERE e.turn_id=h.turn_id)
        OR EXISTS(SELECT 1 FROM bot_harness_events e JOIN bot_harness_cursors c
          ON c.worker_id=e.worker_id AND c.journal_id=e.journal_id AND c.bot_id=h.bot_id
          WHERE e.turn_id=h.turn_id AND e.journal_seq<=c.last_seq))
      ORDER BY h.finished_at,h.turn_id LIMIT 1 FOR UPDATE OF h SKIP LOCKED`;

    const turn = rows[0]?.turn_id;

    if (!turn) return 0;

    const deleted = yield* sql`DELETE FROM bot_harness_events WHERE event_id IN (
    SELECT e.event_id FROM bot_harness_events e JOIN bot_harness_turns h ON h.turn_id=e.turn_id
    JOIN bot_harness_cursors c ON c.worker_id=e.worker_id AND c.journal_id=e.journal_id AND c.bot_id=h.bot_id
    WHERE e.turn_id=${turn}::uuid AND e.journal_seq<=c.last_seq ORDER BY e.journal_seq
    LIMIT ${BATCH} FOR UPDATE OF e SKIP LOCKED) RETURNING event_id`;

    yield* sql`UPDATE bot_harness_turns SET events_pruned_at=now() WHERE turn_id=${turn}::uuid
    AND NOT EXISTS(SELECT 1 FROM bot_harness_events WHERE turn_id=${turn}::uuid)`;

    return Math.max(1, deleted.length);
  });

const pruneMirror = (sql: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    // SHARE conflicts with checkpoint/subscription UPDATE. KEY SHARE would allow an expired staging race.
    const rows = yield* sql<{ origin_node_id: string; generation: string }>`SELECT g.origin_node_id,g.generation
    FROM computer_mirror_generations g JOIN computer_mirror_state s USING(owner_user_id,origin_node_id)
    WHERE g.owner_user_id=${owner}::uuid AND g.generation<>s.generation
      AND (g.subscription_id<>s.subscription_id OR g.lease_until<now())
    ORDER BY g.origin_node_id,g.generation LIMIT 1 FOR UPDATE OF g SKIP LOCKED FOR SHARE OF s SKIP LOCKED`;

    const row = rows[0];

    if (!row) return 0;

    const deleted =
      yield* sql`DELETE FROM computer_mirror_threads WHERE (owner_user_id,origin_node_id,generation,thread_id) IN (
    SELECT owner_user_id,origin_node_id,generation,thread_id FROM computer_mirror_threads
    WHERE owner_user_id=${owner}::uuid AND origin_node_id=${row.origin_node_id} AND generation=${row.generation}::uuid
    ORDER BY thread_id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING thread_id`;

    yield* sql`DELETE FROM computer_mirror_generations WHERE owner_user_id=${owner}::uuid
    AND origin_node_id=${row.origin_node_id} AND generation=${row.generation}::uuid AND NOT EXISTS(
      SELECT 1 FROM computer_mirror_threads WHERE owner_user_id=${owner}::uuid
        AND origin_node_id=${row.origin_node_id} AND generation=${row.generation}::uuid)`;

    return Math.max(1, deleted.length);
  });
