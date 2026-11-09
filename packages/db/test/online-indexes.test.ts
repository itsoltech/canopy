import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { migrate, migrateOnline } from "../src/index.ts";
import { runIndexTasks } from "../src/migrations/index-tasks.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

describe.skipIf(!dockerAvailable)("restartable online performance indexes", () => {
  let pg: TestPostgres;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  let other: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

  const query = <A extends object>(text: string, params: readonly unknown[] = []) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, [...params]);
      }),
    );

  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    other = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(migrateOnline);
  }, 60000);
  afterAll(async () => {
    await runtime?.dispose();
    await other?.dispose();
    await pg?.stop();
  });

  test("online migration is idempotent and rejects nesting in a transaction", async () => {
    expect(await runtime.runPromise(migrateOnline)).toEqual([]);
    await expect(
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(migrateOnline);
        }),
      ),
    ).rejects.toThrow("outside a transaction");
  });

  test("a changed definition fails closed without dropping the existing index", async () => {
    await query("DROP INDEX worker_commands_redelivery_expiry");

    try {
      await query("CREATE INDEX worker_commands_redelivery_expiry ON worker_commands(worker_id)");
      await expect(runtime.runPromise(migrateOnline)).rejects.toThrow("unexpected definition");

      const rows = await query<{ definition: string }>(
        "SELECT pg_get_indexdef('worker_commands_redelivery_expiry'::regclass) AS definition",
      );

      expect(rows[0]?.definition).toEndWith("USING btree (worker_id)");
    } finally {
      await query("DROP INDEX IF EXISTS worker_commands_redelivery_expiry");
      await runtime.runPromise(migrate);
    }
  });

  test("waiting for another migrator can be cancelled without retaining a snapshot", async () => {
    let release = () => {};
    let acquired = () => {};

    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const connection = yield* sql.reserve;
          yield* Effect.acquireRelease(
            connection.executeUnprepared("SELECT pg_advisory_lock(183516401,1)", [], undefined),
            () =>
              connection.executeUnprepared("SELECT pg_advisory_unlock(183516401,1)", [], undefined).pipe(Effect.orDie),
          );
          acquired();
          yield* Effect.promise(() => hold);
        }),
      ),
    );

    await ready;
    const abort = new AbortController();

    const waiting = other.runPromise(runIndexTasks([], true), { signal: abort.signal }).then(
      () => false,
      () => true,
    );

    try {
      await Bun.sleep(100);
      abort.abort();
      expect(await Promise.race([waiting, Bun.sleep(1000).then(() => false)])).toBe(true);
      expect(
        await query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_lock(183516401, 1)%'`),
      ).toEqual([]);
    } finally {
      abort.abort();
      release();
      await holder;
      await waiting;
    }

    await other.runPromise(runIndexTasks([], true));
  });

  test("a cancelled concurrent build leaves an invalid index which a new runtime repairs", async () => {
    await query("DROP INDEX worker_commands_redelivery_expiry");
    let release = () => {};
    let acquired = () => {};

    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writer = runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const connection = yield* sql.reserve;
          yield* connection.executeUnprepared("BEGIN", [], undefined);

          try {
            yield* connection.executeUnprepared("LOCK TABLE worker_commands IN ROW EXCLUSIVE MODE", [], undefined);
            acquired();
            yield* Effect.promise(() => hold);
          } finally {
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }
        }),
      ),
    );

    await ready;

    try {
      const failed = other.runPromise(migrateOnline);

      // Attach the rejection handler before cancelling the backend.
      const result = failed.then(
        () => false,
        () => true,
      );

      await waitForBuild();
      await query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE datname=current_database() AND query LIKE 'CREATE INDEX CONCURRENTLY worker_commands_redelivery_expiry %'
          AND state='active'`);
      expect(await result).toBe(true);
      expect(
        await query<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index
        WHERE indexrelid='worker_commands_redelivery_expiry'::regclass`),
      ).toEqual([{ valid: false }]);
    } finally {
      release();
      await writer;
    }

    await other.dispose();
    other = ManagedRuntime.make(pg.layer);
    await Promise.all([runtime.runPromise(migrateOnline), other.runPromise(migrateOnline)]);
    expect(
      await query<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index
      WHERE indexrelid='worker_commands_redelivery_expiry'::regclass`),
    ).toEqual([{ valid: true }]);
  }, 10000);

  test("writes continue while a concurrent build waits for an older writer", async () => {
    await query("DROP INDEX worker_commands_redelivery_expiry");
    let release = () => {};
    let acquired = () => {};

    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writer = runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const connection = yield* sql.reserve;
          yield* connection.executeUnprepared("BEGIN", [], undefined);

          try {
            yield* connection.executeUnprepared("LOCK TABLE worker_commands IN ROW EXCLUSIVE MODE", [], undefined);
            acquired();
            yield* Effect.promise(() => hold);
          } finally {
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }
        }),
      ),
    );

    await ready;
    const building = other.runPromise(migrateOnline);

    try {
      await waitForBuild();
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL lock_timeout = '500ms'`;
              // Empty DML still takes the table lock that a normal insert/update needs.
              yield* sql`UPDATE worker_commands SET status='completed' WHERE false`;
            }),
          );
        }),
      );
    } finally {
      release();
      await writer;
      await building;
    }
  }, 10000);

  async function waitForBuild() {
    const deadline = Date.now() + 3000;

    for (;;) {
      const active = await query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE 'CREATE INDEX CONCURRENTLY worker_commands_redelivery_expiry %' AND state='active'
        AND wait_event_type='Lock'`);

      if (active.length) return;

      if (Date.now() > deadline) throw new Error("Concurrent index build did not wait on the fixture writer");
      await Bun.sleep(10);
    }
  }
});
