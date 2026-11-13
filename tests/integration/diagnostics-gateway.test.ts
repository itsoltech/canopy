import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code } from "@connectrpc/connect";
import { Effect, Exit, Stream } from "effect";
import { SqlClient, type SqlConnection } from "effect/sql";
import { ProcessGovernor, PROCESS_LIMITS } from "@canopy/process-governor";
import { databaseMetric, governorMetric, Measure, measureKey, type DatabaseFamily } from "@canopy/domain/diagnostics";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { projectIds } from "../../apps/gateway/src/config-sync/project-aliases.ts";
import { observedReserve, databaseMonitor } from "../../apps/gateway/src/diagnostics/database.ts";
import { observedBorrow } from "../../apps/gateway/src/diagnostics/database-borrow.ts";
import { queryFamily } from "../../apps/gateway/src/diagnostics/query-context.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { sanitizeSnapshot } from "../../apps/gateway/src/diagnostics/sanitize.ts";
import { diagnosticsResponse } from "../../apps/gateway/src/diagnostics/response.ts";
import { diagnosticErrorCode } from "../../apps/gateway/src/diagnostics/error-code.ts";
import { decodeRollup } from "../../apps/gateway/src/diagnostics/rollup.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("gateway diagnostics preserve durable, private operations", () => {
  let gateway: TestGateway;
  let thread: string;
  const secret = "private-SQL-parameter-and-error-detail";
  const snapshot = () => create(ui.ComputerDiagnosticsSchema, rpcSnapshot(gateway.core.diagnostics.collector, 15));

  const query = <A extends object>(text: string, params: (string | number)[] = []) =>
    gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params);
      }).pipe(queryFamily("thread.read")),
    );

  beforeAll(async () => {
    gateway = await startTestGateway({ diagnostics: true });
    await gateway.core.diagnostics.start();
    const project = (await gateway.api.createProject({ name: "Diagnostics load" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project,
        workerId: gateway.workerId,
        rootPath: "/repo/diagnostics",
      })
    ).workspace!.id;

    thread = (await gateway.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX }))
      .thread!.id;
    await eventually(
      () => query<{ status: string }>("SELECT status FROM threads WHERE id=$1::uuid", [thread]),
      (rows) => rows[0]?.status === "idle",
    );
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("range reads, configuration aliases and overview revisions have stable background families", async () => {
    const collector = gateway.core.diagnostics.collector;

    const events = (family: DatabaseFamily) => {
      collector.flushDatabase();
      const key = measureKey(databaseMetric(family, "execute"));

      return collector.minutes.slots.reduce((sum, slot) => sum + (slot?.measures?.get(key)?.events ?? 0n), 0n);
    };

    const other = events("other");
    const range = events("mirrors.read");
    const config = events("config.sync");
    const feed = events("overview.feeds");
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));
    await gateway.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => projectIds(sql, gateway.userId)));
    const abort = new AbortController();
    const watch = gateway.api.watchOverview({}, { signal: abort.signal })[Symbol.asyncIterator]();

    try {
      await watch.next();
      await eventually(
        async () => events("overview.feeds"),
        (value) => value > feed,
      );
      expect(events("mirrors.read")).toBeGreaterThan(range);
      expect(events("config.sync")).toBeGreaterThan(config);
      expect(events("overview.feeds")).toBeGreaterThan(feed);
      expect(events("other")).toBe(other);
    } finally {
      abort.abort();
      await watch.return?.();
      collector.reset();
    }
  });

  test("real RPC queries keep allowlisted families and isolated method context", async () => {
    await Promise.all(Array.from({ length: 8 }, () => gateway.api.getThread({ threadId: thread })));
    await gateway.api.getOverview({});
    const overview = await gateway.api.getComputerDiagnostics({ windowMinutes: 15, overviewOnly: true });
    expect(overview.database).toEqual([]);
    expect(overview.calls).toEqual([]);

    const detail = await gateway.api.getComputerDiagnostics({ windowMinutes: 15, revision: overview.revision });
    expect(detail.notModified).toBe(false);
    expect(
      detail.calls
        .find((row) => row.method.endsWith("/GetThread"))
        ?.database.some((family) => family.family === "thread.read"),
    ).toBe(true);
    await gateway.api.getComputerDiagnostics({ windowMinutes: 1440 });
    const value = snapshot();
    const call = value.calls.find((row) => row.method.endsWith("/GetThread"));
    expect(call?.database.some((family) => family.family === "thread.read")).toBe(true);
    expect(
      value.calls
        .find((row) => row.method.endsWith("/GetOverview"))
        ?.database.some((family) => family.family === "workers.read"),
    ).toBe(true);
    expect(call?.database.some((family) => family.family === "workers.read")).toBe(false);
    expect(
      value.calls
        .find((row) => row.method.endsWith("/GetComputerDiagnostics"))
        ?.database.some((family) => family.family === "diagnostics.history"),
    ).toBe(true);
    const abort = new AbortController();
    const watch = gateway.api.watchThread({ threadId: thread }, { signal: abort.signal })[Symbol.asyncIterator]();
    await watch.next();
    abort.abort();
    await watch.next().catch(() => undefined);
    expect(
      snapshot()
        .calls.find((row) => row.method.endsWith("/WatchThread"))
        ?.database.some((family) => family.family === "thread.page"),
    ).toBe(true);
    await query("SELECT $1::text AS sensitive", [secret]);
    // PostgreSQL includes a failed cast's input in its driver error message.
    await query("SELECT $1::integer AS sensitive", [secret.repeat(4096)]).catch(() => undefined);
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.ignore(sql.unsafe(`SELECT '${secret}'::int`));
      }).pipe(queryFamily("thread.read")),
    );
    expect(snapshot().database.find((family) => family.family === "thread.read")?.executeErrors).toBeGreaterThan(0n);
    const wire = toJsonString(ui.ComputerDiagnosticsSchema, snapshot());

    for (const forbidden of [secret, "SELECT", "sensitive", "/repo/diagnostics"]) expect(wire).not.toContain(forbidden);
    await gateway.core.diagnostics.persistence!.flush(true);

    const stored = await gateway.core.diagnostics.persistence!.store.query<{ payload: Uint8Array }>(
      "SELECT payload FROM diagnostics_rollups WHERE owner_user_id=$1::uuid",
      [gateway.userId],
    );

    for (const row of stored)
      expect(toJsonString(ui.DiagnosticsRollupSchema, decodeRollup(row.payload))).not.toContain(secret);
  });

  test("execute errors roll back transactions and savepoints without poisoning the pool", async () => {
    await query("CREATE TABLE diagnostic_transaction (id integer PRIMARY KEY)");

    const result = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO diagnostic_transaction VALUES (1)`;
              yield* sql`INSERT INTO diagnostic_transaction VALUES (1)`;
            }),
          ),
        );
      }).pipe(queryFamily("commands.write")),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(await query("SELECT id FROM diagnostic_transaction")).toEqual([]);
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO diagnostic_transaction VALUES (2)`;
            yield* Effect.ignore(sql.withTransaction(sql`INSERT INTO diagnostic_transaction VALUES (2)`));
            yield* sql`INSERT INTO diagnostic_transaction VALUES (3)`;
          }),
        );
      }).pipe(queryFamily("commands.write")),
    );
    expect(await query<{ id: number }>("SELECT id FROM diagnostic_transaction ORDER BY id")).toEqual([
      { id: 2 },
      { id: 3 },
    ]);

    const errors = gateway.core.diagnostics.collector
      .rollup(Math.floor(Date.now() / 60_000) * 60_000)
      ?.measures.find(
        (measure) => measure.metricId === databaseMetric("commands.write", "transaction") && !measure.rpcMethodId,
      )?.errors;

    expect(errors).toBeGreaterThan(0n);
  });

  test("failed reservation and release preserve errors, cleanup and bounded labels", async () => {
    const monitor = databaseMonitor(gateway.runtime)!;

    const failed = await gateway.runtime.runPromise(
      Effect.exit(Effect.scoped(observedReserve(Effect.die(new Error(secret)), monitor))).pipe(
        queryFamily("thread.read"),
      ),
    );

    expect(Exit.isFailure(failed)).toBe(true);

    const released = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const acquire = Effect.gen(function* () {
          const connection = yield* sql.reserve;
          yield* Effect.addFinalizer(() => Effect.die(new Error(secret)));

          return connection;
        });

        return yield* Effect.exit(Effect.scoped(observedReserve(acquire, monitor)));
      }).pipe(queryFamily("thread.read")),
    );

    expect(Exit.isFailure(released)).toBe(true);
    expect(monitor.waiting).toBe(0);
    expect(monitor.occupied).toBe(0);
    const family = snapshot().database.find((row) => row.family === "thread.read");
    expect(family?.reserveErrors).toBe(1n);
    expect(family?.releaseErrors).toBe(1n);

    const canceled = await gateway.runtime.runPromise(
      Effect.exit(
        Effect.scoped(observedReserve(Effect.never, monitor)).pipe(
          Effect.timeout("20 millis"),
          queryFamily("queue.read"),
        ),
      ),
    );

    expect(Exit.isFailure(canceled)).toBe(true);
    expect(monitor.waiting).toBe(0);
    expect(toJsonString(ui.ComputerDiagnosticsSchema, snapshot())).not.toContain(secret);
    expect((await query<{ alive: number }>("SELECT 1 AS alive"))[0]?.alive).toBe(1);
  });

  test("borrowed statements close leases on acquisition, work, cancellation and release failures", async () => {
    const monitor = databaseMonitor(gateway.runtime)!;
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const reserve = sql.reserve;

        const lease =
          (acquire: SqlConnection.Acquirer): SqlConnection.Borrower =>
          (work) =>
            Effect.scoped(Effect.flatMap(acquire, work));

        const failed = yield* Effect.exit(
          observedBorrow(lease(Effect.die(new Error(secret))), monitor)(() => Effect.void),
        );

        expect(Exit.isFailure(failed)).toBe(true);

        const releaseFailure = Effect.gen(function* () {
          const connection = yield* reserve;
          yield* Effect.addFinalizer(() => Effect.die(new Error(secret)));

          return connection;
        });

        const released = yield* Effect.exit(observedBorrow(lease(releaseFailure), monitor)(() => Effect.void));
        expect(Exit.isFailure(released)).toBe(true);

        // A cleanup defect replaces a typed work error; reason counts alone would miss it.
        const both = yield* Effect.exit(observedBorrow(lease(releaseFailure), monitor)(() => Effect.fail(secret)));
        expect(Exit.isFailure(both)).toBe(true);

        let inspected = 0;
        const driverFailure = new Error(secret);

        // Replace the lazy stack before message: JSC may read message while materializing the stack property.
        for (const field of ["stack", "parameters", "query", "detail", "cause", "message"])
          Object.defineProperty(driverFailure, field, {
            get() {
              inspected++;
              throw new Error("Diagnostics inspected a private driver failure");
            },
          });

        const privateExit = yield* Effect.exit(
          observedBorrow(lease(reserve), monitor)(() => Effect.fail(driverFailure)),
        );

        expect(Exit.isFailure(privateExit)).toBe(true);
        expect(diagnosticErrorCode(driverFailure)).toBe(Code.Unknown);
        expect(inspected).toBe(0);

        const thrown = yield* Effect.exit(
          observedBorrow(
            lease(reserve),
            monitor,
          )((): Effect.Effect<void> => {
            throw new Error(secret);
          }),
        );

        expect(Exit.isFailure(thrown)).toBe(true);

        const cancelled = yield* Effect.exit(
          observedBorrow(lease(reserve), monitor)(() => Effect.never).pipe(Effect.timeout("20 millis")),
        );

        expect(Exit.isFailure(cancelled)).toBe(true);
      }).pipe(queryFamily("threads.metadata")),
    );
    expect(monitor.waiting).toBe(0);
    expect(monitor.occupied).toBe(0);
    const measures = gateway.core.diagnostics.collector.rollup(Math.floor(Date.now() / 60_000) * 60_000)!.measures;
    expect(measures.find((row) => row.metricId === databaseMetric("threads.metadata", "reserve"))?.errors).toBe(1n);
    expect(measures.find((row) => row.metricId === databaseMetric("threads.metadata", "release"))?.errors).toBe(2n);
    expect(toJsonString(ui.ComputerDiagnosticsSchema, snapshot())).not.toContain(secret);
    expect((await query<{ alive: number }>("SELECT 1 AS alive"))[0]?.alive).toBe(1);
  });

  test("native result modes, stream pins and after-commit callbacks preserve transaction semantics", async () => {
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const select = sql<{ value: number }>`SELECT 7::integer AS value`;
        expect(yield* select.values).toEqual([[7]]);
        expect(yield* select.valuesUnprepared).toEqual([[7]]);
        expect(yield* select.unprepared).toEqual([{ value: 7 }]);
        expect(yield* select.withoutTransform).toEqual([{ value: 7 }]);
        expect(yield* Stream.runCollect(select.stream)).toEqual([{ value: 7 }]);
        expect(yield* select.raw).toMatchObject({ command: "SELECT", rows: [{ value: 7 }] });
        yield* sql`CREATE TABLE diagnostic_commit (id integer PRIMARY KEY)`;
        const committed: number[] = [];
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO diagnostic_commit VALUES (1)`;
            yield* sql.afterCommit(
              Effect.gen(function* () {
                const rows = yield* sql<{ id: number }>`SELECT id FROM diagnostic_commit`;
                committed.push(...rows.map((row) => row.id));
              }).pipe(Effect.orDie),
            );
          }),
        );
        expect(committed).toEqual([1]);

        const aborted = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO diagnostic_commit VALUES (2)`;
              yield* Effect.ignore(sql`INSERT INTO diagnostic_commit VALUES (2)`);
              yield* sql.afterCommit(Effect.sync(() => committed.push(2)));
            }),
          ),
        );

        expect(Exit.isFailure(aborted)).toBe(true);
        expect(committed).toEqual([1]);
        expect(yield* sql`SELECT id FROM diagnostic_commit ORDER BY id`).toEqual([{ id: 1 }]);
      }).pipe(queryFamily("threads.metadata")),
    );
    const monitor = databaseMonitor(gateway.runtime)!;
    expect(monitor.waiting).toBe(0);
    expect(monitor.occupied).toBe(0);
  });

  test("steady RPC fixture labels at least 95 percent of database executions", async () => {
    const before = snapshot();

    const count = (value: ui.ComputerDiagnostics, id: number) =>
      value.gatewayMeasures.find((measure) => measure.metricId === id)?.events ?? 0n;

    for (let cycle = 0; cycle < 20; cycle++) {
      await gateway.api.getThread({ threadId: thread });
      await gateway.api.getOverview({});
      await gateway.api.getSettings({});
      await gateway.api.listThreads({});
      await gateway.api.listModels({});
      await gateway.api.getUpdates({});
      await gateway.api.listBots({});
      await gateway.api.listGitHubAccounts({});
      await gateway.api.getComputerDiagnostics({ windowMinutes: 15 });
    }

    const after = snapshot();
    const total = count(after, 11) - count(before, 11);
    const other = count(after, 10) - count(before, 10);
    console.info(
      `Steady SQL coverage: ${total - other}/${total} named (${((100 * Number(total - other)) / Number(total)).toFixed(2)}%), ${other} other`,
    );
    expect(total).toBeGreaterThan(100n);
    expect(Number(total - other) / Number(total)).toBeGreaterThanOrEqual(0.95);
  }, 60_000);

  test("ingest remains durable while a receiver falls behind and metrics reveal queue pressure", async () => {
    const abort = new AbortController();
    const watch = gateway.api.watchThread({ threadId: thread }, { signal: abort.signal })[Symbol.asyncIterator]();
    await watch.next();
    const slow = gateway.core.hub.subscribeThread(thread);

    const before = (await query<{ seq: bigint }>("SELECT last_seq AS seq FROM threads WHERE id=$1::uuid", [thread]))[0]!
      .seq;

    try {
      for (let index = 0; index < 300; index++)
        gateway.worker.emit(thread, "", {
          case: "activity",
          value: {},
        });

      const stored = await eventually(
        () =>
          query<{ count: number }>(
            "SELECT count(*)::int AS count FROM thread_events WHERE thread_id=$1::uuid AND seq>$2",
            [thread, Number(before)],
          ),
        (rows) => (rows[0]?.count ?? 0) >= 300,
        45_000,
      );

      expect(stored[0]?.count).toBe(300);
      await eventually(
        async () => snapshot(),
        (value) => (value.gatewayMeasures.find((row) => row.metricId === 22)?.events ?? 0n) >= 300n,
        10_000,
      );
      gateway.core.diagnostics.tick();
      const measures = snapshot().gatewayMeasures;
      expect(measures.find((row) => row.metricId === 21)?.events).toBeGreaterThanOrEqual(300n);
      expect(measures.find((row) => row.metricId === 36)?.events).toBeGreaterThan(0n);
      expect(measures.find((row) => row.metricId === 31)?.events).toBeGreaterThanOrEqual(300n);
      expect(measures.find((row) => row.metricId === 32)?.events).toBeGreaterThanOrEqual(300n);
      expect(measures.find((row) => row.metricId === 34)?.max).toBe(256);

      const cursor = await query<{ seq: bigint }>(
        "SELECT acked_seq AS seq FROM worker_journal_cursors WHERE worker_id=$1::uuid AND thread_id=$2::uuid",
        [gateway.workerId, thread],
      );

      expect(cursor[0]?.seq).toBeGreaterThanOrEqual(300n);
    } finally {
      slow.close();
      abort.abort();
      await watch.next().catch(() => undefined);
    }
  }, 60_000);

  test("governor observers preserve admissions, joins, cache and cancellation", async () => {
    const governor = new ProcessGovernor({ ...PROCESS_LIMITS, git: 1 }, 1, 1, 2, () => {});
    const collector = gateway.core.diagnostics.collector;

    const stop = governor.observe((kind, priority, event, elapsed) =>
      collector.measure(governorMetric(kind, priority, event), event === "wait" || event === "execution" ? elapsed : 1),
    );

    const blocker = Promise.withResolvers<void>();

    try {
      const running = governor.run({ kind: "git", key: secret, ttlMs: 1000 }, () => blocker.promise);
      const joined = governor.run({ kind: "git", key: secret }, async () => {});
      expect(joined).toBe(running);
      const abort = new AbortController();

      const queued = governor.run({ kind: "git", signal: abort.signal }, async () => {
        throw new Error("must not run");
      });

      const canceled = queued.catch((error: Error) => error);
      abort.abort();
      expect((await canceled).message).toContain("cancelled");
      blocker.resolve();
      await running;
      await governor.run({ kind: "git", key: secret, ttlMs: 1000 }, async () => {});
      expect(governor.snapshot().started).toBe(1);
      expect(governor.snapshot().joined).toBe(1);
      expect(governor.snapshot().cacheHits).toBe(1);
      expect(
        snapshot().gatewayMeasures.find((row) => row.metricId === governorMetric("git", "user", "cancelled"))?.events,
      ).toBe(1n);
    } finally {
      blocker.resolve();
      stop();
    }
  });

  test("new histograms and RPC correlations survive retry and a gateway restart with owner isolation", async () => {
    const method = registered(ui.GatewayService.method.getThread);
    const at = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
    const source = new RpcCollector([method], { utc: () => at, monotonic: () => 0 });
    source.measure(databaseMetric("thread.page", "execute"), 42, false, method.id);
    source.measure(3, 10_000, false, 0, 5000);
    source.measure(governorMetric("git", "user", "admitted"), 7);
    source.start(method.id)!.finish();
    const partial = new Measure(() => false);
    partial.timing(100, true, at);
    const process = source.rollup(at)!;
    process.measures.push(partial.snapshot(databaseMetric("queue.read", "execute"), method.id));
    const store = new DiagnosticsStore(gateway.runtime, gateway.userId, "local");
    const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1, epoch: crypto.randomUUID() });
    await store.write([{ at, processes: [process] }], state);
    await store.write([{ at, processes: [process] }], state);
    const foreign = new DiagnosticsStore(gateway.runtime, crypto.randomUUID(), "local");
    expect(await foreign.state()).toBeUndefined();
    const other = [];

    for await (const row of foreign.history(at - 1)) other.push(row);
    expect(other).toEqual([]);

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ diagnostics: true, storage });
    await gateway.core.diagnostics.start();
    await gateway.core.diagnostics.persistence!.start();

    for (const windowMinutes of [15, 60, 1440]) {
      const value = await gateway.api.getComputerDiagnostics({ windowMinutes });

      const family = value.calls
        .find((row) => row.method === method.name)
        ?.database.find((row) => row.family === "thread.page");

      expect(family?.executeMs?.samples).toBe(1n);
      expect(family?.executeMs?.max).toBe(42);

      const incomplete = value.calls
        .find((row) => row.method === method.name)
        ?.database.find((row) => row.family === "queue.read");

      expect(incomplete?.executeErrors).toBe(1n);
      expect(incomplete?.incomplete).toBe(true);
      expect(incomplete?.executeMs?.samples).toBe(0n);
      expect(value.gatewayMeasures.find((row) => row.metricId === 3)?.max).toBeGreaterThanOrEqual(10_000);
    }

    expect(toJsonString(ui.ComputerDiagnosticsSchema, snapshot())).not.toContain(secret);
  }, 60_000);
});

test("peer and response boundaries reject unregistered SQL labels and bound optional detail", () => {
  const method = registered(ui.GatewayService.method.getThread);

  const value = create(ui.ComputerDiagnosticsSchema, {
    calls: [
      {
        layer: "rpc",
        method: method.name,
        database: [
          { family: "SELECT private_parameter" },
          { family: "thread.page", executeMs: { samples: 1n, max: 1 } },
        ],
      },
    ],
    database: [{ family: "SELECT private_parameter" }],
    gatewayMeasures: [{ metricId: 999999, last: 1 }],
    findings: [{ ruleId: "db_slow", subject: "SELECT private_parameter", severity: "critical" }],
  });

  const sanitized = sanitizeSnapshot(value);
  expect(toJsonString(ui.ComputerDiagnosticsSchema, sanitized)).not.toContain("private_parameter");
  expect(sanitized.calls[0]?.database[0]?.family).toBe("thread.page");
  expect(sanitized.gatewayMeasures).toEqual([]);

  const original = create(ui.ComputerDiagnosticsSchema, {
    calls: Array.from({ length: 32 }, () => ({
      method: method.name,
      database: Array.from({ length: 10 }, () => ({
        family: "thread.page",
        executeMs: { samples: 1n, max: 1e30, sum: 1e30, p50: 1e30, p95: 1e30, p99: 1e30 },
      })),
    })),
  });

  const bounded = diagnosticsResponse(original, create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true }));
  expect(bounded.calls).toHaveLength(32);
  expect(original.calls.every((row) => row.database.length === 10)).toBe(true);
  expect(bounded.droppedSamples).toBeGreaterThan(0n);
});
