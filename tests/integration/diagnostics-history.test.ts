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
          "SELECT count(*)::int n FROM diagnostics_rollups WHERE resolution=60 AND bucket_start<now()-interval '72 hours'",
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
          "SELECT count(*)::int n FROM diagnostics_rollups WHERE resolution=60 AND bucket_start<now()-interval '72 hours'",
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
    const reader = new DiagnosticsPersistence(storage, new RpcCollector([method]), makeHost(restored));
    await reader.start();
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
      SELECT $1::uuid,'quota',60,to_timestamp($2/1000.0)-n*interval '1 minute',$3 FROM generate_series(1,4320) n`,
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
      (await query<{ n: number }>("SELECT count(*)::int n FROM diagnostics_rollups WHERE computer_id='quota'"))[0]?.n,
    ).toBe(4320);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id='quota'", [gateway.userId]);
  });
});
