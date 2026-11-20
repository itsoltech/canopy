import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";
import { pruneStorage } from "../../../apps/gateway/src/maintenance/storage.ts";
import { pruneThreadBlobs } from "../../../apps/gateway/src/maintenance/thread-blobs.ts";
import { stagePreview } from "../../../apps/gateway/src/store/preview-uploads.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function seed(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const owner = Bun.randomUUIDv7();
    const worker = Bun.randomUUIDv7();
    const project = Bun.randomUUIDv7();
    const workspace = Bun.randomUUIDv7();
    const local = Bun.randomUUIDv7();
    const moved = Bun.randomUUIDv7();
    yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,'history@example.test','History','user')`;
    yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${worker}::uuid,${owner}::uuid,'history','fixture')`;
    yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${project}::uuid,${owner}::uuid,'History','history')`;
    yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${workspace}::uuid,${project}::uuid,${worker}::uuid,'/repo')`;

    for (const sample of ["attached", "history", "unclaimed", "snapshot"]) {
      const data = Buffer.from(sample);
      yield* sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data,created_at,retention_exempt)
        VALUES(${digest(sample)},${data.length},'text/plain',${data},now()-interval '60 days',true)`;
    }

    for (const thread of [local, moved]) {
      const turn = Bun.randomUUIDv7();
      yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
        VALUES(${thread}::uuid,${project}::uuid,${owner}::uuid,'main',${thread}::uuid,'worker','codex',${worker}::uuid,${workspace}::uuid,'/repo')`;
      yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,input,first_seq,last_seq)
        VALUES(${turn}::uuid,${thread}::uuid,1,'completed','provider','{}',1,1)`;
      yield* sql`INSERT INTO attachments(id,owner_user_id,thread_id,turn_id,sha256,name,mime_type,kind,size_bytes)
        VALUES(${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${thread}::uuid,${turn}::uuid,${digest("attached")},'a.txt','text/plain','file',8)`;
      yield* sql`INSERT INTO thread_blobs(thread_id,sha256) VALUES(${thread}::uuid,${digest("attached")})`;

      if (thread === moved) {
        yield* sql`INSERT INTO computer_moved_threads(thread_id,ordinal_turn_id,from_node_id,history)
          VALUES(${thread}::uuid,${turn}::uuid,'source',${Buffer.from(digest("snapshot"))})`;
        yield* sql`INSERT INTO thread_blobs(thread_id,sha256) VALUES(${thread}::uuid,${digest("snapshot")})`;
      }
    }

    const item = { itemId: "command", commandExecution: { outputBlob: { sha256: digest("history") } } };
    yield* sql`INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES(${local}::uuid,'command','command_execution','completed',${JSON.stringify(item)}::jsonb,1,1)`;
    yield* sql`INSERT INTO thread_blobs(thread_id,sha256) VALUES(${local}::uuid,${digest("history")}),(${local}::uuid,${digest("unclaimed")})`;

    return { owner, worker, local, moved };
  });
}

test.skipIf(!dockerAvailable)(
  "pre-upgrade history survives long offline periods without granting hash-only access",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((entries) => entries.filter(([id]) => id < 180))),
          table: "schema_migrations",
        }),
      );
      const { local, moved, owner, worker } = await runtime.runPromise(SqlClient.SqlClient.use(seed));
      await runtime.runPromise(migrate);
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            const grant = (thread: string, sample: string) => sql<{ verified: boolean }>`
        SELECT verified FROM thread_blobs WHERE thread_id=${thread}::uuid AND sha256=${digest(sample)}`;

            expect(yield* grant(local, "attached")).toEqual([{ verified: true }]);
            expect(yield* grant(moved, "attached")).toEqual([{ verified: false }]);
            yield* sql`UPDATE thread_blobs SET unverified_until=now()-interval '1 day'`;
            yield* sql`UPDATE blobs SET legacy_retention_until=now()-interval '1 day'`;
            yield* sql.withTransaction(pruneStorage(sql, owner));
            expect(yield* grant(local, "unclaimed")).toHaveLength(0);
            expect(yield* sql`SELECT 1 FROM blobs WHERE sha256=${digest("unclaimed")}`).toHaveLength(0);
            expect(yield* grant(local, "history")).toEqual([{ verified: false }]);
            expect(yield* grant(moved, "snapshot")).toEqual([{ verified: false }]);
            expect(
              yield* sql`SELECT 1 FROM blobs WHERE sha256 IN (${digest("history")},${digest("snapshot")})`,
            ).toHaveLength(2);

            yield* stagePreview(sql, {
              workerId: worker,
              journalId: "recovered",
              threadId: local,
              sha256: digest("history"),
              data: Buffer.from("history"),
              mimeType: "text/plain",
            });
            expect(yield* grant(local, "history")).toEqual([{ verified: true }]);
            yield* sql.withTransaction(pruneThreadBlobs(sql, moved));
            expect(yield* sql`SELECT 1 FROM blobs WHERE sha256=${digest("snapshot")}`).toHaveLength(0);
            expect(yield* sql`SELECT 1 FROM blobs WHERE sha256=${digest("attached")}`).toHaveLength(1);
          }),
        ),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
