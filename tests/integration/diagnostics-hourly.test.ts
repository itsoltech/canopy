import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { Diagnostics } from "../../apps/gateway/src/diagnostics/service.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { DiagnosticsHistory } from "../../apps/gateway/src/diagnostics/history.ts";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { DiagnosticsPersistence } from "../../apps/gateway/src/diagnostics/persistence.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { decodeRollup, encodeRollup } from "../../apps/gateway/src/diagnostics/rollup.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";

describe.skipIf(!dockerAvailable)("sparse hourly diagnostics", () => {
  let gateway: TestGateway;
  const method = registered(ui.GatewayService.method.getClientCapabilities);
  const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1 });

  const host = {
    state: () => ({ findings: [], watermarks: [], peerOverviews: [] }),
    restore: () => {},
    restoreProcess: () => {},
    processes: () => [],
  };

  const process = (at: number, count = 3n, session = "previous") =>
    create(ui.DiagnosticsProcessSchema, {
      processId: "gateway",
      session,
      sequence: BigInt(at),
      series: [
        {
          methodId: method.id,
          started: count,
          completed: count,
          duration: { indices: [40, 44], counts: [count - 1n, 1n], sum: Number(count), max: 2 },
        },
      ],
      coverage: [{ startMs: BigInt(at), endMs: BigInt(at + 60_000) }],
    });

  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("restores only an hour and serves older data from owner-scoped hours without duplicating minutes", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const store = new DiagnosticsStore(gateway.runtime, gateway.userId, "hourly");
    await store.initialize(state);
    const at = Math.floor(now / 60_000) * 60_000 - 60_000;
    await store.query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload)
      SELECT $1::uuid,'hourly',60,to_timestamp($2/1000.0)-n*interval '1 minute',$3 FROM generate_series(121,4440) n`,
      [gateway.userId, at, encodeRollup([process(at - 4 * 3_600_000, 99n)])],
    );
    await store.query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload)
      VALUES($1::uuid,'hourly',60,to_timestamp($2/1000.0),$3),
      ($1::uuid,'hourly',3600,to_timestamp($4/1000.0),$5)`,
      [
        gateway.userId,
        at,
        encodeRollup([process(at)]),
        hour - 7_200_000,
        encodeRollup([process(hour - 7_200_000, 9n)]),
      ],
    );
    const collector = new RpcCollector([method], { utc: () => now, monotonic: () => 0 });
    await new DiagnosticsPersistence(store, collector, host).start();
    expect(rpcSnapshot(collector, 60).calls[0]?.completed).toBe(3n);
    let rows = 0;

    for await (const _ of store.history(now - 3_600_000, now)) rows++;
    expect(rows).toBe(1);
    expect(collector.budget.dropped).toBe(0);
    expect(collector.budget.used).toBeLessThan(16 * 1024);
    const history = new DiagnosticsHistory(store, (p, id) => p === "gateway" && id === method.id);
    await history.load(now);
    const view = rpcSnapshot(collector, 1440, history.values.get("gateway"));
    expect(view.calls[0]?.completed).toBe(12n);
    expect(view.calls[0]?.durationMs?.samples).toBe(12n);
    expect(view.resolutionSeconds).toBe(3600);
    expect(view.gaps.length).toBeGreaterThan(0);

    const foreign = new DiagnosticsHistory(
      new DiagnosticsStore(gateway.runtime, crypto.randomUUID(), "hourly"),
      () => true,
    );

    await foreign.load(now);
    expect(foreign.values.size).toBe(0);
  });

  test("writes a completed hour in the same batch, replacing retry and late-session contributions exactly once", async () => {
    const store = new DiagnosticsStore(gateway.runtime, gateway.userId, "hour-write");
    await store.initialize(state);
    const at = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
    const one = [{ at, processes: [process(at)] }];
    const two = [{ at: at + 60_000, processes: [process(at + 60_000, 5n)] }];
    await store.write(one, state);
    await store.write(two, state);
    await store.write(one, state);
    await store.write([{ at, processes: [process(at, 7n, "restarted")] }], state);

    const rows = await store.query<{ payload: Uint8Array }>(
      `SELECT payload FROM diagnostics_rollups
      WHERE owner_user_id=$1::uuid AND computer_id='hour-write' AND resolution=3600`,
      [gateway.userId],
    );

    expect(rows.length).toBe(1);
    const aggregate = decodeRollup(rows[0]!.payload).processes[0]!.series[0]!;
    expect(aggregate.completed).toBe(15n);
    expect(aggregate.duration?.indices.length).toBe(2);
    expect(aggregate.duration?.counts.reduce((n, value) => n + value, 0n)).toBe(15n);
    expect(aggregate.duration?.max).toBe(2);
  });

  test("rolling restored windows expire sparse counts and maxima without re-persisting old sessions", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
    const at = Math.floor(now / 60_000) * 60_000;
    const store = new DiagnosticsStore(gateway.runtime, gateway.userId, "rolling");
    await store.initialize(state);
    await store.write(
      [
        { at: at - 14 * 60_000, processes: [process(at - 14 * 60_000, 7n)] },
        { at: at - 13 * 60_000, processes: [process(at - 13 * 60_000, 3n)] },
      ],
      state,
    );
    const collector = new RpcCollector([method], { utc: () => now, monotonic: () => now });
    await new DiagnosticsPersistence(store, collector, host).start();
    expect(rpcSnapshot(collector, 15).calls[0]?.completed).toBe(10n);
    now += 60_000;
    collector.tick();
    expect(rpcSnapshot(collector, 15).calls[0]?.completed).toBe(3n);
    expect(rpcSnapshot(collector, 15).calls[0]?.durationMs?.samples).toBe(3n);
    expect(rpcSnapshot(collector, 60).calls[0]?.completed).toBe(10n);
    expect(collector.rollup(at - 13 * 60_000)).toBeUndefined();
    now += 14 * 60_000;
    collector.tick();
    expect(rpcSnapshot(collector, 15).calls).toEqual([]);
  });

  test("a locked history table cannot delay listener readiness or application RPCs", async () => {
    let release!: () => void;
    let locked!: () => void;

    const unlocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const holder = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`LOCK TABLE diagnostics_rollups IN ACCESS EXCLUSIVE MODE`;
            locked();
            yield* Effect.promise(() => unlocked);
          }),
        );
      }),
    );

    const diagnostics = new Diagnostics(gateway.core, {
      runtime: gateway.runtime,
      userId: gateway.userId,
      instanceId: "lazy-restore-test",
      role: "server",
    });

    try {
      await acquired;
      await diagnostics.start();
      expect(diagnostics.persistence?.restoring).toBe(true);
      await gateway.api.getClientCapabilities({});
      expect(diagnostics.persistence?.restoring).toBe(true);
    } finally {
      release();
      await holder;
      await diagnostics.persistence?.start();
      await diagnostics.stop();
    }

    expect(diagnostics.persistence?.status).toBe("saved");
  });
});
