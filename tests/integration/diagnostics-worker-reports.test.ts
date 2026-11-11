import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Measure, harnessMetric, diagnosticsFindings } from "@canopy/domain/diagnostics";
import { dockerAvailable } from "@canopy/db/testing";
import { startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { DiagnosticsHistory } from "../../apps/gateway/src/diagnostics/history.ts";
import { LinkDiagnostics } from "../../apps/gateway/src/diagnostics/links.ts";
import { BucketBudget } from "../../apps/gateway/src/diagnostics/buckets.ts";
import { encodeRollup } from "../../apps/gateway/src/diagnostics/rollup.ts";
import { sanitizeSnapshot } from "../../apps/gateway/src/diagnostics/sanitize.ts";
import { diagnosticsResponse } from "../../apps/gateway/src/diagnostics/response.ts";
import { Findings } from "../../apps/gateway/src/diagnostics/findings.ts";
import { WorkerDiagnostics } from "../../apps/worker/src/diagnostics/worker.ts";

describe.skipIf(!dockerAvailable)("worker reports across real gRPC and persisted windows", () => {
  let gateway: TestGateway;
  const session = crypto.randomUUID();
  const metric = harnessMetric("codex", "turn");

  const report = (sequence: bigint) => {
    const measure = new Measure();
    measure.timing(25, false, Date.now());

    return create(ui.WorkerLinkDiagnosticsSchema, {
      session,
      sequence,
      startMs: BigInt(Date.now() - 1000),
      endMs: BigInt(Date.now()),
      rtt: {},
      jitter: {},
      workerMeasuresSupported: true,
      measures: [measure.snapshot(metric)],
    });
  };

  beforeAll(async () => {
    gateway = await startTestGateway({
      diagnostics: true,
      worker: { hello: { capabilities: ["diagnostics_v1", "worker_diagnostics_v1"] } },
    });
    await gateway.core.diagnostics.start();
    await eventually(async () => gateway.core.diagnostics.persistence?.ready, Boolean);
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("deduplicates the same batch, rejects unknown series and strips unknown protobuf payloads", async () => {
    const value = report(1n);
    // A future/hostile string field must not survive the numeric-only boundary.
    value.measures[0] = fromBinary(
      ui.DiagnosticsMeasureAggregateSchema,
      new Uint8Array([
        ...toBinary(ui.DiagnosticsMeasureAggregateSchema, value.measures[0]!),
        0x9a,
        0x06,
        0x06,
        ...new TextEncoder().encode("secret"),
      ]),
    );
    gateway.worker.link.send({ case: "diagnostics", value });
    gateway.worker.link.send({ case: "diagnostics", value });

    const link = await eventually(
      async () => gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`),
      (link) => link?.watermark.sequence === 1n,
    );

    expect(link?.snapshot(15, "Worker", true, true).measures.find((row) => row.metricId === metric)?.events).toBe(1n);
    expect(
      toJsonString(ui.DiagnosticsProcessSchema, link!.rollup(Math.floor(Date.now() / 60_000) * 60_000)!),
    ).not.toContain("secret");

    for (const invalid of [999, 200, 1001]) {
      const bad = report(2n);
      bad.measures[0]!.metricId = invalid;
      gateway.worker.link.send({ case: "diagnostics", value: bad });
    }

    await gateway.api.getClientCapabilities({});
    expect(link!.watermark.sequence).toBe(1n);
    expect(gateway.worker.link.welcome.workerDiagnosticsV1).toBe(true);
    const view = await gateway.api.getComputerDiagnostics({});
    expect(view.links.find((row) => row.targetId === gateway.workerId)?.measuresSupported).toBe(true);
  });

  test("restored checkpoints block replay and hourly views retain worker-only measures with owner scope", async () => {
    const source = gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`)!;
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    const process = source.rollup(at)!;
    const restarted = new LinkDiagnostics(gateway.workerId, "worker", new BucketBudget(2 * 1024 * 1024));
    restarted.restoring = true;
    expect(restarted.report(report(1n))).toBe(true);
    restarted.collector.restore(process, at);
    restarted.restoreWatermark(source.watermark);
    restarted.resume();
    expect(restarted.snapshot(15, "Worker", true, true).measures.find((row) => row.metricId === metric)?.events).toBe(
      1n,
    );
    expect(restarted.report(report(1n))).toBe(false);
    expect(restarted.report(report(2n))).toBe(true);
    expect(restarted.snapshot(15, "Worker", true, true).measures.find((row) => row.metricId === metric)?.events).toBe(
      2n,
    );
    const storage = new DiagnosticsStore(gateway.runtime, gateway.userId, "worker-hourly");
    await storage.initialize(create(ui.DiagnosticsStateSchema, { schemaVersion: 1 }));
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 7_200_000;
    await storage.query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload)
      VALUES($1::uuid,$2,3600,to_timestamp($3/1000.0),$4)`,
      [gateway.userId, "worker-hourly", hour, encodeRollup([process])],
    );
    const history = new DiagnosticsHistory(storage, (id) => id === `worker:${gateway.workerId}`);
    await history.load(Date.now());
    const hourly = history.values.get(`worker:${gateway.workerId}`);
    expect(hourly?.measures?.size).toBe(1);

    const foreign = new DiagnosticsHistory(
      new DiagnosticsStore(gateway.runtime, crypto.randomUUID(), "worker-hourly"),
      () => true,
    );

    await foreign.load(Date.now());
    expect(foreign.values.size).toBe(0);
  });

  test("remote details reject cross-kind IDs and shed optional measures before worker identities", () => {
    const value = create(ui.ComputerDiagnosticsSchema, {
      links: Array.from({ length: 16 }, (_, index) => ({
        targetId: `worker-${index}`,
        kind: "worker",
        name: "Worker",
        measuresSupported: true,
        measures: Array.from({ length: 60 }, () => ({
          metricId: metric,
          events: 1n,
          distribution: { samples: 1n, p50: 25, p95: 25, p99: 25, max: 25, sum: 25 },
        })),
      })),
    });

    const limited = diagnosticsResponse(value, create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true }));
    expect(toBinary(ui.ComputerDiagnosticsSchema, limited).length).toBeLessThanOrEqual(16 * 1024);
    expect(limited.links.length).toBe(16);
    expect(value.links[0]!.measures.length).toBe(60);

    const remote = create(ui.ComputerDiagnosticsSchema, {
      links: [{ kind: "computer", targetId: "peer", measures: [{ metricId: metric }, { metricId: 200 }] }],
    });

    expect(sanitizeSnapshot(remote).links[0]!.measures.map((row) => row.metricId)).toEqual([200]);
  });

  test("worker health requires sustained fresh evidence and keeps gaps out of recovery", () => {
    const findings = new Findings();

    const snapshot = create(ui.ComputerDiagnosticsSchema, {
      observedSeconds: 900,
      links: [
        {
          kind: "worker",
          targetId: gateway.workerId,
          online: true,
          measuresSupported: true,
          measures: [
            { metricId: 2, events: 60n, observedSeconds: 300, mean: 95, last: 95 },
            { metricId: 120, events: 5n, last: 1024 ** 3 },
            { metricId: 121, events: 5n, last: 20 * 1024 ** 3 },
            { metricId: 100, events: 5n, last: 1 },
            { metricId: 102, events: 5n, last: 60_000 },
          ],
        },
      ],
    });

    const rows = snapshot.links[0]!.measures;
    rows[0]!.observedSeconds = 299;
    findings.evaluate(snapshot);
    expect(findings.states.has(`worker_cpu:worker:${gateway.workerId}`)).toBe(false);
    rows[0]!.observedSeconds = 300;

    for (let tick = 0; tick < 3; tick++) {
      rows[3]!.last++;
      findings.evaluate(snapshot);
    }

    expect(
      findings
        .snapshot()
        .map((row) => row.ruleId)
        .sort(),
    ).toEqual(["worker_backlog", "worker_cpu", "worker_disk"]);
    rows[0]!.mean = 60;
    rows[1]!.last = 4 * 1024 ** 3;
    rows[3]!.last = 0;
    const recent = create(ui.ComputerDiagnosticsSchema, { ...snapshot, links: [] });

    for (let tick = 0; tick < 6; tick++) findings.evaluate(snapshot, recent);
    expect(findings.snapshot().every((row) => row.suspended)).toBe(true);
    expect(findings.snapshot().length).toBe(3);

    // The first fresh backlog observation after a gap establishes a new growth baseline.
    for (let tick = 0; tick < 6; tick++) findings.evaluate(snapshot);
    expect(findings.snapshot()).toEqual([]);
  });

  test("one link finding preserves both observers without summing directional samples", () => {
    const computers = [
      create(ui.ComputerDiagnosticsSchema, {
        computerId: "a",
        name: "Computer A",
        status: "online",
        sampledAtMs: 1n,
        findings: [{ ruleId: "link_slow", subject: "computer:b", value: 600, samples: 30n, observedSeconds: 900 }],
      }),
      create(ui.ComputerDiagnosticsSchema, {
        computerId: "b",
        name: "Computer B",
        status: "offline",
        sampledAtMs: 1n,
        findings: [
          {
            ruleId: "link_slow",
            subject: "computer:a",
            value: 800,
            samples: 40n,
            observedSeconds: 600,
            suspended: true,
          },
        ],
      }),
    ];

    const merged = diagnosticsFindings(computers);
    expect(merged.length).toBe(1);
    expect(merged[0]!.title).toContain("Computer A");
    expect(merged[0]!.title).toContain("Computer B");
    expect(merged[0]!.finding.samples).toBe(40n);
    expect(merged[0]!.observations.map((row) => [row.samples, row.coverage])).toEqual([
      [30n, 900],
      [40n, 600],
    ]);
    expect(merged[0]!.observations[1]!.freshness).toBe("Last known finding");
  });

  test("counter reports stay inside their batch when the worker clock advances during drain", async () => {
    const batch = report(99n);

    const diagnostics = new WorkerDiagnostics(
      () => 0,
      () => Number(batch.endMs) + 10,
    );

    diagnostics.enabled = true;
    diagnostics.record(103, 5);
    diagnostics.measurements.report(batch);
    expect(batch.measures[0]!.sampledAtMs).toBe(batch.endMs);
    gateway.worker.link.send({ case: "diagnostics", value: batch });

    const link = await eventually(
      async () => gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`),
      (link) => link?.watermark.sequence === 99n,
    );

    expect(link?.snapshot(15, "Worker", true, true).measures.find((row) => row.metricId === 103)?.events).toBe(5n);
    diagnostics.stop();
  });
});
