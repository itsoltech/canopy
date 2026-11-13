import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { ui } from "@canopy/contracts";

type Key = { kind: string; entity_id: string; position: string; turn_id: string };

/** ID-only keyset selection; no historical content crosses the database boundary. */
export function clientWindowKeys(sql: SqlClient.SqlClient, thread: string, request: ui.WatchThreadRequest) {
  return Effect.gen(function* () {
    const size = Math.max(1, Math.min(request.pageSize || 24, 100));
    const itemLimit = Math.min(128, size * 6);

    const turns = yield* sql<Key>`WITH candidates AS (
      SELECT 'turn' AS kind,u.id::text AS entity_id,(u.ordinal::bigint-c.level::bigint*1000000000) AS position,u.id::text AS turn_id
        FROM thread_fork_chain(${thread}::uuid) c JOIN turns u ON u.thread_id=c.thread_id
        WHERE u.status<>'queued' AND (c.upto_seq IS NULL OR u.last_seq<=c.upto_seq)
          AND thread_turn_visible_at(u.id,c.upto_seq)
      UNION ALL SELECT kind,entity_id,position,turn_id FROM thread_replication_seed_entities WHERE thread_id=${thread}::uuid AND kind='legacy_turn'
    ) SELECT kind,entity_id,position::text,turn_id FROM candidates WHERE position<coalesce(
      (SELECT position FROM candidates WHERE entity_id=${request.beforeTurnId} LIMIT 1),9223372036854775807)
      ORDER BY position::bigint DESC,entity_id DESC LIMIT ${size + 1}`;

    const items = yield* sql<Key>`WITH candidates AS (
      SELECT 'item' AS kind,i.item_id AS entity_id,(i.first_seq-c.level::bigint*1000000000) AS position,coalesce(i.turn_id::text,'') AS turn_id
        FROM thread_fork_chain(${thread}::uuid) c JOIN thread_items i ON i.thread_id=c.thread_id
        WHERE (c.upto_seq IS NULL OR i.first_seq<=c.upto_seq) AND thread_turn_visible_at(i.turn_id,c.upto_seq)
      UNION ALL SELECT kind,entity_id,position,turn_id FROM thread_replication_seed_entities WHERE thread_id=${thread}::uuid AND kind='legacy_item'
    ) SELECT kind,entity_id,position::text,turn_id FROM candidates WHERE (position,entity_id)<coalesce(
      (SELECT (position,entity_id) FROM candidates WHERE entity_id=${request.beforeItemId} LIMIT 1),ROW(9223372036854775807,''::text))
      ORDER BY position::bigint DESC,entity_id DESC LIMIT ${itemLimit + 1}`;

    const metadata = yield* sql<{ kind: string; entity_id: string }>`SELECT 'interaction' AS kind,id::text AS entity_id
      FROM interaction_requests WHERE thread_id=${thread}::uuid AND status='pending' ORDER BY created_at DESC LIMIT 32`;

    const extras = yield* sql<{ kind: string; entity_id: string }>`
      (SELECT 'notice' AS kind,seq::text AS entity_id FROM thread_events WHERE thread_id=${thread}::uuid AND kind='notice' ORDER BY seq DESC LIMIT 32)
      UNION ALL (SELECT 'steer',id::text FROM turn_steers WHERE thread_id=${thread}::uuid ORDER BY created_at DESC LIMIT 32)
      UNION ALL SELECT 'goal',${thread} WHERE EXISTS(SELECT 1 FROM goals WHERE thread_id=${thread}::uuid)
      UNION ALL (SELECT 'turn',id::text FROM turns WHERE thread_id=${thread}::uuid AND status='queued' ORDER BY ordinal LIMIT 32)
      UNION ALL (SELECT 'delivery',id::text FROM agent_bus_calls WHERE source_thread_id=${thread}::uuid ORDER BY created_at DESC LIMIT 32)`;

    const selectedTurns = turns.slice(0, size);
    const selectedItems = items.slice(0, itemLimit);

    const supporting = selectedItems.flatMap((item) =>
      item.turn_id ? [{ kind: item.kind === "legacy_item" ? "legacy_turn" : "turn", entity_id: item.turn_id }] : [],
    );

    const keys = new Map(
      [
        ...selectedTurns,
        ...selectedItems,
        ...supporting,
        ...metadata,
        ...extras,
        { kind: "thread", entity_id: thread },
      ].map((key) => [`${key.kind}:${key.entity_id}`, { ...key, seq: "0" }]),
    );

    return {
      keys: [...keys.values()],
      turnIds: selectedTurns.map((turn) => turn.entity_id),
      turnsMore: turns.length > size,
      itemsMore: items.length > itemLimit,
      beforeTurn: selectedTurns.at(-1)?.entity_id ?? request.beforeTurnId,
      beforeItem: selectedItems.at(-1)?.entity_id ?? request.beforeItemId,
    };
  });
}
