import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ComputerStore } from "./store.ts";
import { StoredThreadFields } from "./stored-thread-fields.ts";

/** Called under the source barrier when legacy_ready is false. Converts moved history entity by entity. */
export function prepareRangeLegacy(sql: SqlClient.SqlClient, store: Pick<ComputerStore, "query">, thread: string) {
  return Effect.gen(function* () {
    yield* sql`DELETE FROM thread_replication_seed_entities WHERE thread_id=${thread}::uuid`;

    const saved = (yield* sql<{
      size: number;
    }>`SELECT octet_length(history) AS size FROM computer_moved_threads WHERE thread_id=${thread}::uuid`)[0];

    if (saved) {
      const iterator = new StoredThreadFields(store, thread, saved.size).entities();

      while (true) {
        const next = yield* Effect.promise(() => iterator.next());

        if (next.done) break;
        const entity = next.value;
        const kind = `legacy_${entity.value.case}`;

        const record = create(ui.ThreadSyncRecordSchema, {
          key: `${kind}:${entity.id}`,
          value: entity.value,
          position: entity.position,
        });

        if (entity.length > 24 * 1024) {
          const content = (yield* sql<{
            sha: string;
          }>`WITH bytes AS (SELECT substring(history FROM ${entity.start + 1}::integer FOR ${entity.length}::integer) AS data
            FROM computer_moved_threads WHERE thread_id=${thread}::uuid), saved AS (
            INSERT INTO thread_replication_content(thread_id,sha256,data) SELECT ${thread}::uuid,encode(sha256(data),'hex'),data FROM bytes
              ON CONFLICT DO NOTHING RETURNING sha256)
            SELECT encode(sha256(data),'hex') AS sha FROM bytes`)[0]!;

          record.content = create(ui.ThreadSyncContentSchema, {
            sha256: content.sha,
            sizeBytes: BigInt(entity.length),
            typeName: entity.typeName,
          });

          if (record.value.case === "item") record.value.value.contentRef = record.content;
        }

        let turnId = "";

        if (entity.value.case === "item") turnId = entity.value.value.turnId;

        if (entity.value.case === "turn") turnId = entity.value.value.id;

        yield* sql`INSERT INTO thread_replication_seed_entities(thread_id,kind,entity_id,payload,turn_id,position)
          VALUES(${thread}::uuid,${kind},${entity.id},${toBinary(ui.ThreadSyncRecordSchema, record)},${turnId},${entity.position})
          ON CONFLICT(thread_id,kind,entity_id) DO UPDATE SET payload=excluded.payload,turn_id=excluded.turn_id,position=excluded.position`;
        yield* sql`SELECT thread_replication_enqueue(${thread}::uuid,${kind},${entity.id})`;
      }
    }

    yield* sql`UPDATE thread_replication_clock SET legacy_ready=true WHERE thread_id=${thread}::uuid`;
  });
}
