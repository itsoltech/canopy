import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect, Exit } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/sql";
import { ProcessGovernor, PROCESS_LIMITS } from "@canopy/process-governor";
import { databaseMetric, governorMetric, Measure } from "@canopy/domain/diagnostics";
import { observedReserve, databaseMonitor } from "../../apps/gateway/src/diagnostics/database.ts";
import { queryFamily } from "../../apps/gateway/src/diagnostics/query-context.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { sanitizeSnapshot } from "../../apps/gateway/src/diagnostics/sanitize.ts";
import { diagnosticsResponse } from "../../apps/gateway/src/diagnostics/response.ts";
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

  test("real RPC queries keep allowlisted families and isolated method context", async () => {
    await Promise.all(Array.from({ length: 8 }, () => gateway.api.getThread({ threadId: thread })));
    await gateway.api.getOverview({});
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
    expect(snapshot().database.find((family) => family.family === "commands.write")?.transactionErrors).toBeGreaterThan(
      0n,
    );
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
        const pg = yield* PgClient.PgClient;

        const acquire = Effect.gen(function* () {
          const connection = yield* pg.reserve;
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
    process.measures.push(partial.snapshot(databaseMetric("queue.read", "execute")));
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
      const incomplete = value.database.find((row) => row.family === "queue.read");
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
