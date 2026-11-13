import {
  Measure,
  METRIC_DEFINITIONS,
  databaseMetric,
  DATABASE_FAMILIES,
  governorMetric,
  WORKER_METRIC_IDS,
  CLIENT_METRICS,
} from "@canopy/domain/diagnostics";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ComputerStore } from "../../apps/gateway/src/computers/store.ts";

export async function seedDiagnosticWorker(computers: ComputerStore, owner: string) {
  const worker = (
    await computers.query<{ id: string }>("SELECT id FROM workers WHERE owner_user_id=$1::uuid ORDER BY name LIMIT 1", [
      owner,
    ])
  )[0];

  if (worker)
    await computers.query(
      `UPDATE workers SET name='Worker with a deliberately long diagnostic name',
    capabilities=capabilities || '{"diagnosticsV1":true,"workerDiagnosticsV1":true}'::jsonb WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
      [worker.id, owner],
    );

  return worker;
}

export function workerPreview(worker: { id: string } | undefined, minute: number, sequence: number) {
  return worker
    ? [
        create(ui.DiagnosticsProcessSchema, {
          processId: `worker:${worker.id}`,
          session: "synthetic-worker-preview",
          sequence: BigInt(sequence),
          measures: syntheticWorkerMeasures(minute + 59_000),
          coverage: [{ startMs: BigInt(minute), endMs: BigInt(minute + 60_000) }],
        }),
      ]
    : [];
}

/** Numeric, deterministic fixtures for gateway details, including last-known resource samples. */
export function syntheticGatewayMeasures(at: number, rpc: number) {
  const result = [];
  // Representative families keep the fixture inside the production collector budget.
  const families = DATABASE_FAMILIES.slice(0, 8);

  for (const definition of METRIC_DEFINITIONS.values()) {
    if (definition.id >= 100) continue;
    const measure = new Measure();

    if (definition.kind === "timing") {
      for (let i = 0; i < 100; i++) measure.timing(i < 95 ? 2 : 125, false, at);
    } else if (definition.kind === "counter")
      measure.counter(definition.id === 10 ? 4 : definition.id === 11 ? 284 : 200, false, at);
    else {
      const value =
        definition.unit === "bytes" ? 128 * 1024 * 1024 : definition.id === 2 ? 23.4 : definition.id === 6 ? 860 : 3;

      measure.gauge(value, 60_000, at);
    }

    result.push(measure.snapshot(definition.id));
  }

  for (const family of families)
    for (const phase of ["reserve", "execute", "release", "transaction"] as const) {
      const value = new Measure();

      for (let i = 0; i < (family.id === 0 ? 4 : 40); i++)
        value.timing(phase === "execute" ? 5 + family.id : 0.2, i === 39, at);
      result.push(value.snapshot(databaseMetric(family.name, phase)));

      if (family.id === 1) result.push(value.snapshot(databaseMetric(family.name, phase), rpc));
    }

  for (const event of ["attempt", "admitted", "wait", "execution", "full", "cancelled", "joined", "cached"] as const) {
    const value = new Measure();

    if (event === "wait" || event === "execution") value.timing(20, false, at);
    else value.counter(40, false, at);
    result.push(value.snapshot(governorMetric("git", "user", event)));
  }

  for (const definition of CLIENT_METRICS) {
    const value = new Measure();

    if (definition.kind === "counter") value.counter(definition.unit === "bytes" ? 8192 : 12, false, at);
    else for (const duration of [2, 7, 24]) value.timing(duration, false, at);
    result.push(value.snapshot(definition.id));
  }

  return result;
}

export function syntheticWorkerMeasures(at: number) {
  return [...WORKER_METRIC_IDS].map((id) => {
    const definition = METRIC_DEFINITIONS.get(id)!;
    const measure = new Measure();

    if (definition.kind === "timing") for (const duration of [12, 20, 125]) measure.timing(duration, false, at);
    else if (definition.kind === "counter") measure.counter(id === 105 ? 2 : 20, false, at);
    else {
      const sample =
        id === 120
          ? 1.5 * 1024 ** 3
          : id === 121
            ? 100 * 1024 ** 3
            : definition.unit === "bytes"
              ? 96 * 1024 ** 2
              : id === 2
                ? 18
                : id === 6
                  ? 860
                  : id === 102
                    ? 45_000
                    : 4;

      measure.gauge(sample, 60_000, at);
    }

    return measure.snapshot(id);
  });
}
