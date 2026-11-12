import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

const through = (last: number) =>
  Migrator.make({})({
    loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id <= last))),
    table: "schema_migrations",
  });

test.skipIf(!dockerAvailable)(
  "thread sync upgrades through each stack stage without skipping migrations or losing durable state",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const user = Bun.randomUUIDv7();
    const worker = Bun.randomUUIDv7();
    const project = Bun.randomUUIDv7();
    const workspace = Bun.randomUUIDv7();
    const thread = Bun.randomUUIDv7();

    try {
      await runtime.runPromise(through(119));
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${user}::uuid,'upgrade@test.local','Owner','user')`;
          yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${worker}::uuid,${user}::uuid,'Worker','hash')`;
          yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${project}::uuid,${user}::uuid,'Project','upgrade')`;
          yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${workspace}::uuid,${project}::uuid,${worker}::uuid,'/repo')`;
          yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status)
            VALUES(${thread}::uuid,${project}::uuid,${user}::uuid,'main',${thread}::uuid,'worker','codex',${worker}::uuid,${workspace}::uuid,'/repo','idle')`;
          yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
            VALUES(${user}::uuid,'upgrade-peer','Peer','certificate','fingerprint')`;
          yield* sql`INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES(${user}::uuid,'upgrade-peer')`;
        }),
      );
      expect(await runtime.runPromise(through(121))).toEqual([
        [120, "thread_ranges"],
        [121, "thread_publication_failures"],
      ]);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO thread_replication_clock(thread_id,owner_user_id,head_seq,legacy_ready)
            VALUES(${thread}::uuid,${user}::uuid,1,true)`;
          yield* sql`INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id,payload)
            SELECT thread_id,epoch,1,'thread',thread_id::text,decode('0801','hex') FROM thread_replication_clock WHERE thread_id=${thread}::uuid`;
          yield* sql`INSERT INTO thread_publication_failures(thread_id,signature,payload,attempts,failed_at)
            VALUES(${thread}::uuid,'upgrade',decode('','hex'),1,0)`;
          yield* sql`INSERT INTO thread_range_failures(owner_user_id,origin_node_id,thread_id,reason,code,retryable)
            VALUES(${user}::uuid,'upgrade-peer',${thread}::uuid,'unavailable',14,true)`;
        }),
      );
      expect(await runtime.runPromise(through(122))).toEqual([[122, "thread_client_cursors"]]);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const [clock] =
            yield* sql`SELECT head_seq::int,checkpoint_seq::int,legacy_ready FROM thread_replication_clock WHERE thread_id=${thread}::uuid`;

          expect(clock).toEqual({ head_seq: 1, checkpoint_seq: 0, legacy_ready: false });

          const [record] =
            yield* sql`SELECT seq::int,encode(payload,'hex') AS payload FROM thread_replication_journal WHERE thread_id=${thread}::uuid`;

          expect(record).toEqual({ seq: 1, payload: "0801" });

          const [failure] =
            yield* sql`SELECT signature,attempts FROM thread_publication_failures WHERE thread_id=${thread}::uuid`;

          expect(failure).toEqual({ signature: "upgrade", attempts: 1 });
        }),
      );
      expect(await runtime.runPromise(through(123))).toEqual([[123, "thread_sync_diagnostics"]]);
      expect(await runtime.runPromise(through(124))).toEqual([[124, "thread_range_lock_order"]]);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const [failure] =
            yield* sql`SELECT reason,code,retryable,frame_bytes::int FROM thread_range_failures WHERE thread_id=${thread}::uuid`;

          expect(failure).toEqual({ reason: "unavailable", code: 14, retryable: true, frame_bytes: 0 });

          const [clock] = yield* sql`SELECT head_seq::int,checkpoint_seq::int,legacy_ready
            FROM thread_replication_clock WHERE thread_id=${thread}::uuid`;

          expect(clock).toEqual({ head_seq: 1, checkpoint_seq: 0, legacy_ready: false });

          const [record] = yield* sql`SELECT seq::int,encode(payload,'hex') AS payload
            FROM thread_replication_journal WHERE thread_id=${thread}::uuid`;

          expect(record).toEqual({ seq: 1, payload: "0801" });

          // Existing clocks retain referential integrity through the new anchor.
          yield* sql`DELETE FROM threads WHERE id=${thread}::uuid`;
          expect(yield* sql`SELECT * FROM thread_replication_sources WHERE thread_id=${thread}::uuid`).toEqual([]);
          expect(yield* sql`SELECT * FROM thread_replication_clock WHERE thread_id=${thread}::uuid`).toEqual([]);
          expect(yield* sql`SELECT * FROM thread_replication_journal WHERE thread_id=${thread}::uuid`).toEqual([]);
          yield* sql`INSERT INTO thread_range_state(owner_user_id,origin_node_id,thread_id,epoch,visible_epoch,
            applied_seq,head_seq,visible_applied_seq,subscription_id)
            VALUES(${user}::uuid,'upgrade-peer',${thread}::uuid,gen_random_uuid(),gen_random_uuid(),7,10,7,gen_random_uuid())`;
        }),
      );
      await runtime.runPromise(through(125));
      expect(await runtime.runPromise(through(126))).toEqual([[126, "thread_sync_time"]]);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const [state] = yield* sql`SELECT applied_seq::int,head_seq::int,visible_applied_seq::int,last_synced_at
            FROM thread_range_state WHERE owner_user_id=${user}::uuid AND thread_id=${thread}::uuid`;

          expect(state).toEqual({ applied_seq: 7, head_seq: 10, visible_applied_seq: 7, last_synced_at: null });
        }),
      );
      await runtime.runPromise(migrate);
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60000,
);
