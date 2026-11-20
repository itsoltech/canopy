import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";
import { threadBlobAccess } from "../../../apps/gateway/src/store/thread-blob-access.ts";

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const baseGif = Buffer.from(
  "47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b",
  "hex",
);

/** Valid 1x1 GIFs that differ only in the first palette colour (bytes 13-15). */
const gif = (colour: number) => Buffer.from(baseGif).fill(colour, 13, 16);

interface Fixture {
  data: Buffer;
  mime: string;
  /** The hash the links name; the hash of `data` unless a case needs them to disagree. */
  hash: string;
}

const fixture = (data: Buffer, mime = "image/gif", hash = sha(data)): Fixture => ({ data, mime, hash });

const fixtures = new Map(
  Object.entries({
    a: fixture(gif(1)),
    b: fixture(gif(2)),
    shared: fixture(gif(3)),
    late: fixture(gif(4)),
    fresh: fixture(gif(5)),
    mention: fixture(gif(6)),
    text: fixture(Buffer.from("plain text, not an image"), "text/plain"),
    garbage: fixture(Buffer.from("not an image at all")),
    // The store holds another image under the hash the link names.
    mismatch: fixture(gif(7), "image/gif", sha(gif(8))),
    missing: fixture(gif(9)),
  }),
);

const fixtureOf = (name: string) => {
  const value = fixtures.get(name);

  if (!value) throw new Error(`Unknown fixture ${name}`);

  return value;
};

/** Bytes the store already had when 0180 ran; the rest never existed or arrive later. */
const preloaded = ["a", "b", "shared", "text", "garbage", "mismatch"];

interface Thread {
  id: string;
  owner: string;
}

interface Threads {
  a1: Thread;
  a2: Thread;
  b1: Thread;
}

/** Only valid, historical image links stay readable, and only in their own thread. */
const granted = new Set(["a1:a", "a1:shared", "b1:b", "b1:shared"]);

const account = (sql: SqlClient.SqlClient, label: string) =>
  Effect.gen(function* () {
    const row = {
      owner: Bun.randomUUIDv7(),
      worker: Bun.randomUUIDv7(),
      project: Bun.randomUUIDv7(),
      workspace: Bun.randomUUIDv7(),
    };

    yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${row.owner}::uuid,${`${label}@example.test`},${label},'user')`;
    yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${row.worker}::uuid,${row.owner}::uuid,${label},'fixture')`;
    yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${row.project}::uuid,${row.owner}::uuid,${label},${label})`;
    yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${row.workspace}::uuid,${row.project}::uuid,${row.worker}::uuid,'/repo')`;

    return row;
  });

/** Every thread is its own tree root. */
const thread = (sql: SqlClient.SqlClient, row: { owner: string; worker: string; project: string; workspace: string }) =>
  Effect.gen(function* () {
    const id = Bun.randomUUIDv7();

    yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
      VALUES(${id}::uuid,${row.project}::uuid,${row.owner}::uuid,'main',${id}::uuid,'worker','codex',${row.worker}::uuid,${row.workspace}::uuid,'/repo')`;

    return { id, owner: row.owner };
  });

/** Two trees for the first owner, one for the second. */
const world = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const a = yield* account(sql, "a");
    const b = yield* account(sql, "b");

    return { a1: yield* thread(sql, a), a2: yield* thread(sql, a), b1: yield* thread(sql, b) };
  });

/** A thread's image: its item and event (no copy of the bytes in raw) and the hash-only link. */
const reference = (sql: SqlClient.SqlClient, threadId: string, name: string, seq: number, claimed = false) =>
  Effect.gen(function* () {
    const { hash } = fixtureOf(name);

    const content = JSON.stringify({
      itemId: `item-${name}`,
      image: { blob: { sha256: hash, mimeType: "image/gif" } },
    });

    yield* sql`INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES(${threadId}::uuid,${`item-${name}`},'image','completed',${content}::jsonb,${seq},${seq})`;
    yield* sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,item_id,payload,raw,occurred_at)
      VALUES(${threadId}::uuid,${seq},${Bun.randomUUIDv7()}::uuid,'worker','item_completed',${`item-${name}`},
        ${`{"itemCompleted":{"item":${content}}}`}::jsonb,NULL,now())`;
    yield* sql`INSERT INTO thread_blobs(thread_id,sha256) VALUES(${threadId}::uuid,${hash})`;

    // Columns of 0180: a mention reported after the cutover is claimed by its event.
    if (claimed)
      yield* sql`UPDATE thread_blobs SET claimed_by_event=true WHERE thread_id=${threadId}::uuid AND sha256=${hash}`;
  });

/** Bytes as they exist before the cutover (old, exempt from retention) or arrive later (plain insert). */
const putBytes = (sql: SqlClient.SqlClient, name: string, old: boolean) => {
  const { data, mime, hash } = fixtureOf(name);

  return old
    ? sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data,created_at,retention_exempt)
        VALUES(${hash},${data.length},${mime},${data},now()-interval '60 days',true)`
    : sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data) VALUES(${hash},${data.length},${mime},${data})`;
};

/** The state an old gateway left: valid and invalid images, one of them shared across both owners. */
const legacy = (sql: SqlClient.SqlClient, threads: Threads) =>
  Effect.gen(function* () {
    for (const name of preloaded) yield* putBytes(sql, name, true);

    for (const [seq, name] of ["a", "text", "garbage", "mismatch", "missing", "late", "shared"].entries())
      yield* reference(sql, threads.a1.id, name, seq + 1);
    yield* reference(sql, threads.b1.id, "b", 1);
    yield* reference(sql, threads.b1.id, "shared", 2);
  });

const seedLegacy = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const threads = yield* world(sql);

    yield* legacy(sql, threads);

    return threads;
  });

const upTo = (runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>, max: number) =>
  runtime.runPromise(
    Migrator.make({})({
      loader: migrations.pipe(Effect.map((entries) => entries.filter(([id]) => id <= max))),
      table: "schema_migrations",
    }),
  );

/** `verified`: links with a proof. `readable`: what the public read path serves (a deleted thread serves nothing). */
const check = (
  sql: SqlClient.SqlClient,
  threads: Threads,
  verified: ReadonlySet<string>,
  readable: ReadonlySet<string> = verified,
) =>
  Effect.gen(function* () {
    for (const [key, { id, owner }] of Object.entries(threads)) {
      for (const [name, { hash }] of fixtures) {
        const pair = `${key}:${name}`;

        const [link] = yield* sql<{ verified: boolean }>`SELECT verified FROM thread_blobs
          WHERE thread_id=${id}::uuid AND sha256=${hash}`;

        const read = yield* sql`SELECT 1 FROM blobs b WHERE b.sha256=${hash}
          AND ${threadBlobAccess(sql, id, hash, owner)}`;

        expect({ pair, verified: link?.verified ?? false, readable: read.length > 0 }).toEqual({
          pair,
          verified: verified.has(pair),
          readable: readable.has(pair),
        });
      }
    }

    // A thread asked on behalf of the other account: no access either.
    for (const name of ["a", "shared"]) {
      const { hash } = fixtureOf(name);

      const read = yield* sql`SELECT 1 FROM blobs b WHERE b.sha256=${hash}
        AND ${threadBlobAccess(sql, threads.a1.id, hash, threads.b1.owner)}`;

      expect(read).toHaveLength(0);
    }
  });

test.skipIf(!dockerAvailable)(
  "a direct upgrade keeps old valid image links, and a soft-deleted thread gets them back on restore",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await upTo(runtime, 179);

      const threads = await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            const seeded = yield* seedLegacy(sql);

            yield* sql`UPDATE threads SET deleted_at=now() WHERE id=${seeded.b1.id}::uuid`;

            return seeded;
          }),
        ),
      );

      await runtime.runPromise(migrate);

      // The link survives the upgrade, but a deleted thread's preview stays hidden until it is restored.
      const visible = new Set([...granted].filter((pair) => !pair.startsWith("b1:")));

      await runtime.runPromise(SqlClient.SqlClient.use((sql) => check(sql, threads, granted, visible)));
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) => sql`UPDATE threads SET deleted_at=NULL WHERE id=${threads.b1.id}::uuid`),
      );
      await runtime.runPromise(SqlClient.SqlClient.use((sql) => check(sql, threads, granted)));
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "an incremental upgrade grants nothing for hashes or bytes first seen after 0180, even when 0184 repeats",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await upTo(runtime, 179);

      const threads = await runtime.runPromise(SqlClient.SqlClient.use(seedLegacy));

      await upTo(runtime, 183);
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            // After 0180: bytes arrive for an old link, a valid new image is mentioned, and each owner's image,
            // whose bytes the store already had, is mentioned in a thread that never had it.
            yield* putBytes(sql, "late", false);
            yield* putBytes(sql, "fresh", false);
            yield* reference(sql, threads.a1.id, "fresh", 20, true);
            yield* reference(sql, threads.a2.id, "b", 21, true);
            yield* reference(sql, threads.b1.id, "a", 21, true);
          }),
        ),
      );
      await runtime.runPromise(migrate);
      await runtime.runPromise(SqlClient.SqlClient.use((sql) => check(sql, threads, granted)));

      // Repeating the migration, after one more new mention, still adds nothing.
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* putBytes(sql, "mention", false);
            yield* reference(sql, threads.b1.id, "mention", 22, true);
            yield* sql`DELETE FROM schema_migrations WHERE migration_id=184`;
          }),
        ),
      );
      await runtime.runPromise(migrate);
      await runtime.runPromise(SqlClient.SqlClient.use((sql) => check(sql, threads, granted)));
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
