import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { DiagnosticsPersistence } from "../../apps/gateway/src/diagnostics/persistence.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { decodeRollup, encodeRollup } from "../../apps/gateway/src/diagnostics/rollup.ts";
import { pruneDiagnostics } from "../../apps/gateway/src/maintenance/diagnostics.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";
import { LinkDiagnostics } from "../../apps/gateway/src/diagnostics/links.ts";
import { BucketBudget } from "../../apps/gateway/src/diagnostics/buckets.ts";
import { Findings } from "../../apps/gateway/src/diagnostics/findings.ts";

describe.skipIf(!dockerAvailable)("diagnostics durability and bounded retention", () => {
  let gateway: TestGateway;
  let store: DiagnosticsStore;
  let persistence: DiagnosticsPersistence;
  const minute = Math.floor(Date.now() / 60_000) * 60_000 - 180_000;
  let utc = minute;
  let mono = 0;
  const method = registered(ui.GatewayService.method.getClientCapabilities);
  const collector = new RpcCollector([method], { utc: () => utc, monotonic: () => mono });

  const host = {
    state: () => ({ findings: [], watermarks: [], peerOverviews: [] }),
    restore: () => {},
    restoreProcess: () => {},
    processes: () => [],
  };

  const advance = (ms: number) => {
    utc += ms;
    mono += ms;
    collector.tick();
  };

  const query = <T extends object>(sql: string, args: (string | number | Uint8Array)[] = []) =>
    store.query<T>(sql, args);

  beforeAll(async () => {
    gateway = await startTestGateway({ diagnostics: true });
    store = new DiagnosticsStore(gateway.runtime, gateway.userId, "local");
    persistence = new DiagnosticsPersistence(store, collector, host);
    await persistence.start();
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("retry atomically replaces a minute and its watermark after a failed write", async () => {
    for (let index = 0; index < 12; index++) {
      const call = collector.start(method.id)!;
      advance(5000);
      call.finish(index % 2 ? 0 : 14);
    }

    await query(`CREATE FUNCTION reject_diagnostics() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic persistence failure'; END $$`);
    await query(
      "CREATE TRIGGER reject_diagnostics BEFORE INSERT ON diagnostics_rollups FOR EACH ROW EXECUTE FUNCTION reject_diagnostics()",
    );
    await persistence.flush();
    expect(persistence.status).toBe("unavailable");
    expect(persistence.pending.size).toBe(1);
    expect((await store.state())?.persistedThroughMs).toBe(0n);
    expect((await query<{ count: number }>("SELECT count(*)::int count FROM diagnostics_rollups"))[0]?.count).toBe(0);
    await query("DROP TRIGGER reject_diagnostics ON diagnostics_rollups");
    await query("DROP FUNCTION reject_diagnostics()");
    await persistence.flush();
    expect(persistence.status).toBe("saved");
    expect((await store.state())?.persistedThroughMs).toBe(BigInt(minute + 60_000));
    const stored = (await query<{ payload: Uint8Array }>("SELECT payload FROM diagnostics_rollups"))[0]!;
    const series = decodeRollup(stored.payload).processes[0]!.series[0]!;
    // The final call completes in the following minute; its start belongs to this minute.
    expect(series.started).toBe(12n);
    expect(series.completed).toBe(11n);
    const state = (await store.state())!;
    await store.write([{ at: minute, processes: decodeRollup(stored.payload).processes }], state);
    expect(
      decodeRollup((await query<{ payload: Uint8Array }>("SELECT payload FROM diagnostics_rollups"))[0]!.payload)
        .processes[0]!.series[0]!.started,
    ).toBe(12n);
    const foreign = new DiagnosticsStore(gateway.runtime, crypto.randomUUID(), "local");
    expect(await foreign.state()).toBeUndefined();
    const foreignHistory = [];

    for await (const value of foreign.history(minute - 1)) foreignHistory.push(value);
    expect(foreignHistory).toEqual([]);
  });

  test("a real gateway restart restores 15 min, 1 h and 24 h counts and marks downtime", async () => {
    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ diagnostics: true, storage });
    store = new DiagnosticsStore(gateway.runtime, gateway.userId, "local");
    await gateway.core.diagnostics.start();
    await gateway.core.diagnostics.persistence?.start();

    for (const windowMinutes of [15, 60, 1440]) {
      const snapshot = await gateway.api.getComputerDiagnostics({ windowMinutes });
      const call = snapshot.calls.find((value) => value.method === method.name);
      expect(call?.started).toBe(12n);
      expect(call?.completed).toBe(11n);
      expect(call?.inFlight).toBe(0);
      expect(
        snapshot.gaps.some((gap) => Number(gap.startMs) <= minute + 60_000 && Number(gap.endMs) > minute + 60_000),
      ).toBe(true);
      expect(snapshot.restoring).toBe(false);
    }

    const short = await gateway.api.getComputerDiagnostics({ windowMinutes: 1 });
    expect(short.calls.find((value) => value.method === method.name)).toBeUndefined();
  });

  test("expires failed batches before they can recreate pruned minute history", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000;
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "expired-retry");
    const clock = { utc: () => now, monotonic: () => now };
    const live = new RpcCollector([method], clock);
    const writer = new DiagnosticsPersistence(storage, live, host);
    await writer.start();
    live.start(method.id)!.finish();
    live.tick();
    const at = now;
    const process = live.rollup(at)!;
    writer.pending.set(at, { minute: { at, processes: [process] }, bytes: 0 });
    now += 3_660_000;
    live.start(method.id)!.finish();
    live.tick();
    await writer.flush(true);
    expect(writer.status).toBe("persistence_gap");
    expect((await storage.state())?.persistenceGap).toBe(true);

    const rows = await storage.query<{ bucket_start: Date }>(
      "SELECT bucket_start FROM diagnostics_rollups WHERE owner_user_id=$1::uuid AND computer_id='expired-retry'",
      [gateway.userId],
    );

    expect(rows.some((row) => new Date(row.bucket_start).getTime() === at)).toBe(false);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='expired-retry'", [
      gateway.userId,
    ]);
  });

  test("a full restore preserves live collection and writes, then releases expired history", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000;
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "restore-budget");
    const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1, epoch: crypto.randomUUID() });
    await storage.initialize(state);
    await storage.write(
      Array.from({ length: 20 }, (_, index) => {
        const at = now - (20 - index) * 60_000;

        return {
          at,
          processes: [
            create(ui.DiagnosticsProcessSchema, {
              processId: "gateway",
              session: "previous",
              sequence: BigInt(at),
              series: [{ methodId: method.id, started: 1n, completed: 1n }],
              coverage: [{ startMs: BigInt(at), endMs: BigInt(at + 60_000) }],
            }),
          ],
        };
      }),
      state,
    );
    const budget = new BucketBudget(64 * 1024);
    const live = new RpcCollector([method], { utc: () => now, monotonic: () => now }, budget);
    const writer = new DiagnosticsPersistence(storage, live, host);
    await writer.start();
    expect(budget.dropped).toBeGreaterThan(0);
    const historical = rpcSnapshot(live, 15).calls[0]!.started;
    expect(historical).toBeGreaterThan(0n);
    const call = live.start(method.id);
    expect(call).toBeDefined();
    now += 5000;
    live.tick();
    call!.finish();
    expect(rpcSnapshot(live, 15).calls[0]?.started).toBe(historical + 1n);
    expect(rpcSnapshot(live, 15).calls[0]?.started).toBe(historical + 1n);
    await writer.flush(true);
    expect(writer.status).toBe("saved");

    const rows = await storage.query<{ payload: Uint8Array }>(
      "SELECT payload FROM diagnostics_rollups WHERE owner_user_id=$1::uuid AND computer_id='restore-budget' ORDER BY bucket_start DESC LIMIT 1",
      [gateway.userId],
    );

    const fresh = decodeRollup(rows[0]!.payload).processes.find((process) => process.session === live.session);
    expect(fresh?.series[0]?.started).toBe(1n);
    expect(fresh?.series[0]?.completed).toBe(1n);
    const allocated = budget.used;
    now += 86_400_000;
    live.tick();
    expect(live.historyMinutes.slots.every((slot) => !slot)).toBe(true);
    expect(budget.used).toBeLessThan(allocated);
    expect(rpcSnapshot(live, 15).calls).toEqual([]);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='restore-budget'", [
      gateway.userId,
    ]);
  });

  test("restored overflow samples mark only the affected percentile ranks", async () => {
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "overflow");
    const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1 });
    await storage.initialize(state);
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    await storage.write(
      [
        {
          at,
          processes: [
            create(ui.DiagnosticsProcessSchema, {
              processId: "gateway",
              session: "overflow",
              sequence: 1n,
              series: [
                {
                  methodId: method.id,
                  started: 100n,
                  completed: 100n,
                  duration: { indices: [20, 129], counts: [98n, 2n], sum: 1e9, max: 5e8 },
                  requestBytes: { indices: [31], counts: [100n], sum: 5e11, max: 5e9 },
                },
              ],
            }),
          ],
        },
      ],
      state,
    );
    const restored = new RpcCollector([method]);
    await new DiagnosticsPersistence(storage, restored, host).start();
    const call = rpcSnapshot(restored, 15).calls[0]!;
    expect(call.durationMs?.overflow).toBe(true);
    expect(call.durationMs?.overflowQuantiles).toBe(4);
    expect(call.durationMs?.max).toBe(5e8);
    expect(call.requestBytes?.overflowQuantiles).toBe(7);
    expect(call.requestBytes?.p95).toBe(2 ** 30);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='overflow'", [
      gateway.userId,
    ]);
  });

  test("compacts an hour without double counting, respects owner scope and rolls pruning back", async () => {
    const payload = encodeRollup([
      create(ui.DiagnosticsProcessSchema, {
        processId: "gateway",
        session: "retention",
        sequence: 1n,
        series: [
          {
            methodId: method.id,
            started: 1n,
            completed: 1n,
            duration: { indices: [5], counts: [1n], max: 0.002, sum: 0.002 },
          },
        ],
      }),
    ]);

    await query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload)
      SELECT $1::uuid,'local',60,date_trunc('hour',now()-interval '4 days')+n*interval '1 minute',$2 FROM generate_series(0,59) n`,
      [gateway.userId, payload],
    );
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* pruneDiagnostics(sql, gateway.userId);

              return yield* Effect.fail(new Error("rollback"));
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
      }),
    );
    expect(
      (await query<{ n: number }>("SELECT count(*)::int n FROM diagnostics_rollups WHERE resolution=3600"))[0]?.n,
    ).toBe(0);

    const prune = (owner: string) =>
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(pruneDiagnostics(sql, owner));
        }),
      );

    await prune(crypto.randomUUID());
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM diagnostics_rollups WHERE resolution=60 AND bucket_start<now()-interval '2 hours'",
        )
      )[0]?.n,
    ).toBe(60);
    await prune(gateway.userId);

    const hour = (
      await query<{ payload: Uint8Array }>("SELECT payload FROM diagnostics_rollups WHERE resolution=3600")
    )[0]!;

    expect(decodeRollup(hour.payload).processes[0]!.series[0]!.started).toBe(60n);
    await prune(gateway.userId);
    expect(
      decodeRollup(
        (await query<{ payload: Uint8Array }>("SELECT payload FROM diagnostics_rollups WHERE resolution=3600"))[0]!
          .payload,
      ).processes[0]!.series[0]!.started,
    ).toBe(60n);
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM diagnostics_rollups WHERE resolution=60 AND bucket_start<now()-interval '2 hours'",
        )
      )[0]?.n,
    ).toBe(0);
    await query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload,compacted)
      VALUES($1::uuid,'local',3600,date_trunc('hour',now()-interval '31 days'),$2,true)`,
      [gateway.userId, payload],
    );
    await prune(gateway.userId);
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM diagnostics_rollups WHERE bucket_start<now()-interval '30 days'",
        )
      )[0]?.n,
    ).toBe(0);
  });

  test("restarting inside a minute never persists restored observations as a new session", async () => {
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    let now = at + 1000;
    const clock = { utc: () => now, monotonic: () => now - at };
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "same-minute");
    const first = new RpcCollector([method], clock);
    const one = new DiagnosticsPersistence(storage, first, host);
    await one.start();
    first.start(method.id)!.finish();
    now += 5000;
    await one.flush(true);

    now += 1000;
    const second = new RpcCollector([method], clock);
    const two = new DiagnosticsPersistence(storage, second, host);
    await two.start();
    second.start(method.id)!.finish();
    now += 5000;
    await two.flush(true);
    const third = new RpcCollector([method], clock);
    const three = new DiagnosticsPersistence(storage, third, host);
    await three.start();
    expect(rpcSnapshot(third, 15).calls[0]?.started).toBe(2n);
    expect(rpcSnapshot(third, 60).calls[0]?.completed).toBe(2n);
    expect(rpcSnapshot(third, 1440).calls[0]?.durationMs?.samples).toBe(2n);
    expect(third.rollup(at)).toBeUndefined();
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='same-minute'", [
      gateway.userId,
    ]);
  });

  test("concurrent writers and pruning preserve each session exactly once", async () => {
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "concurrent");
    const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1 });
    await storage.initialize(state);
    const at = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;

    const minutes = ["one", "two", "three"].map((session) => [
      {
        at,
        processes: [
          create(ui.DiagnosticsProcessSchema, {
            processId: "gateway",
            session,
            sequence: 1n,
            series: [{ methodId: method.id, started: 1n, completed: 1n }],
          }),
        ],
      },
    ]);

    await Promise.all(minutes.map((value) => storage.write(value, state)));
    await Promise.all([
      storage.write(minutes[0]!, state),
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(pruneDiagnostics(sql, gateway.userId));
        }),
      ),
    ]);

    const minute = await storage.query<{ payload: Uint8Array }>(
      "SELECT payload FROM diagnostics_rollups WHERE owner_user_id=$1::uuid AND computer_id='concurrent' AND resolution=60",
      [gateway.userId],
    );

    expect(decodeRollup(minute[0]!.payload).processes.reduce((n, p) => n + p.series[0]!.started, 0n)).toBe(3n);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='concurrent'", [
      gateway.userId,
    ]);
  });

  test("restored findings suspend downtime and require fresh recovery evidence", async () => {
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "findings");

    const saved = create(ui.DiagnosticsStateSchema, {
      schemaVersion: 1,
      findings: [
        {
          ruleId: "rpc_slow",
          subject: `rpc:${method.name}`,
          active: true,
          severity: "warning",
          entering: 3,
        },
      ],
    });

    await storage.initialize(saved);
    const findings = new Findings();
    findings.restore((await storage.state())!.findings);
    expect(findings.snapshot()[0]?.suspended).toBe(true);

    const healthy = create(ui.ComputerDiagnosticsSchema, {
      observedSeconds: 900,
      calls: [{ layer: "rpc", method: method.name, completed: 100n, durationMs: { samples: 100n, p95: 5 } }],
    });

    findings.evaluate(healthy, create(ui.ComputerDiagnosticsSchema));
    expect(findings.snapshot()[0]?.suspended).toBe(true);

    for (let minute = 0; minute < 4; minute++) findings.evaluate(healthy, healthy);
    expect(findings.snapshot()[0]?.active).toBe(true);
    expect(findings.snapshot()[0]?.suspended).toBe(false);
    findings.evaluate(healthy, healthy);
    expect(findings.snapshot()).toEqual([]);
    const afterLoss = new Findings();
    afterLoss.restore((await storage.state())!.findings);
    const limited = create(ui.ComputerDiagnosticsSchema, { ...healthy, droppedSamples: 1n });
    afterLoss.evaluate(limited, limited);

    for (let minute = 0; minute < 14; minute++) afterLoss.evaluate(limited, limited);
    expect(afterLoss.snapshot()[0]?.suspended).toBe(true);
    afterLoss.evaluate(limited, limited);
    expect(afterLoss.snapshot()[0]?.suspended).toBe(false);
    limited.droppedSamples = 2n;
    afterLoss.evaluate(limited, limited);
    expect(afterLoss.snapshot()[0]?.suspended).toBe(true);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='findings'", [
      gateway.userId,
    ]);
  });

  test("report checkpoints survive failed writes and two worker sessions in one minute", async () => {
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "checkpoints");
    const link = new LinkDiagnostics(gateway.workerId, "worker", new BucketBudget());

    const makeHost = (value: LinkDiagnostics) => ({
      ...host,
      restore: (state: ui.DiagnosticsState) => {
        for (const checkpoint of state.watermarks) value.restoreWatermark(checkpoint);
      },
      restoreProcess: (process: ui.DiagnosticsProcess, at: number) => value.collector.restore(process, at),
      processes: (at: number) => {
        const process = value.rollup(at);

        return process ? [process] : [];
      },
    });

    const first = new RpcCollector([method]);
    const writer = new DiagnosticsPersistence(storage, first, makeHost(link));
    await writer.start();

    const report = create(ui.WorkerLinkDiagnosticsSchema, {
      session: "first",
      sequence: 4n,
      rtt: { indices: [20], counts: [3n], sum: 1, max: 1 },
      jitter: {},
    });

    expect(link.report(report)).toBe(true);
    expect(link.report(create(ui.WorkerLinkDiagnosticsSchema, { ...report, session: "second", sequence: 1n }))).toBe(
      true,
    );
    first.start(method.id)!.finish();
    first.tick();
    await writer.flush(true);
    expect((await storage.state())?.watermarks.map((value) => value.sequence)).toEqual([4n, 1n]);
    const restored = new LinkDiagnostics(gateway.workerId, "worker", new BucketBudget());
    restored.restoring = true;
    expect(restored.report(report)).toBe(true);
    const reader = new DiagnosticsPersistence(storage, new RpcCollector([method]), makeHost(restored));
    await reader.start();
    restored.resume();
    expect(restored.report(report)).toBe(false);
    expect(
      restored.report(create(ui.WorkerLinkDiagnosticsSchema, { ...report, session: "second", sequence: 1n })),
    ).toBe(false);
    expect(restored.snapshot(15, "Worker", true, true).rttMs?.samples).toBe(6n);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='checkpoints'", [
      gateway.userId,
    ]);
  });

  test("allows replacement at the minute quota, rejects growth and preserves wide counters", async () => {
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "quota");
    const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1 });
    await storage.initialize(state);
    const at = Math.floor(Date.now() / 60_000) * 60_000;

    const process = create(ui.DiagnosticsProcessSchema, {
      processId: "gateway",
      session: "wide",
      sequence: 1n,
      series: [
        {
          methodId: method.id,
          started: 4_294_967_300n,
          completed: 4_294_967_299n,
          duration: { indices: [20], counts: [4_294_967_299n], sum: 1000, max: 1 },
        },
      ],
    });

    const payload = encodeRollup([process]);
    await query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload)
      SELECT $1::uuid,'quota',60,to_timestamp($2/1000.0)-n*interval '1 minute',$3 FROM generate_series(1,180) n`,
      [gateway.userId, at, payload],
    );
    await storage.write([{ at: at - 60_000, processes: [process] }], state);
    await expect(storage.write([{ at, processes: [process] }], state)).rejects.toThrow("quota");
    const restored = new RpcCollector([method], { utc: () => at + 1000, monotonic: () => 0 });
    const reader = new DiagnosticsPersistence(storage, restored, host);
    await reader.start();
    expect(rpcSnapshot(restored, 15).calls[0]?.started).toBeGreaterThan(0xffff_ffffn);
    expect(rpcSnapshot(restored, 15).calls[0]?.durationMs?.samples).toBeGreaterThan(0xffff_ffffn);
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM diagnostics_rollups WHERE computer_id='quota' AND resolution=60",
        )
      )[0]?.n,
    ).toBe(180);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='quota'", [gateway.userId]);
  });
});
