import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram } from "@canopy/domain/diagnostics";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { gatewayRuntime, ensureDevUser } from "../../apps/gateway/src/runtime.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { RPC_METHODS } from "../../apps/gateway/src/diagnostics/registry.ts";
import { encodeRollup } from "../../apps/gateway/src/diagnostics/rollup.ts";

/** Two hours of sparse minute detail and thirty days of hourly summaries with real coverage. */
export async function seedDiagnosticsHistory(env: Record<string, string | undefined>) {
  const runtime = gatewayRuntime(env);

  try {
    const owner = await ensureDevUser(runtime, "dev@localhost");
    const store = new DiagnosticsStore(runtime, owner, "local");
    const duration = new Histogram();

    for (let index = 0; index < 12; index++) duration.record([0.8, 1.2, 1.6, 2][index % 4]!);

    const process = create(ui.DiagnosticsProcessSchema, {
      processId: "gateway",
      session: "synthetic-history",
      sequence: 1n,
      series: RPC_METHODS.filter((method) => !method.stream)
        .slice(0, 24)
        .map((method) => ({
          methodId: method.id,
          started: 12n,
          completed: 12n,
          codes: [12n],
          duration: duration.snapshot(),
        })),
    });

    await store.initialize(create(ui.DiagnosticsStateSchema, { schemaVersion: 1, epoch: crypto.randomUUID() }));
    let payloadBytes = 0;

    for (const [resolution, count] of [
      [60, 120],
      [3600, 720],
    ] as const) {
      const boundary = Math.floor(Date.now() / (resolution * 1000)) * resolution * 1000;

      const values = Array.from({ length: count }, (_, index) => {
        const at = boundary - (index + 1) * resolution * 1000;
        const factor = resolution / 60;

        const value = create(ui.DiagnosticsProcessSchema, {
          ...process,
          sequence: BigInt(at),
          coverage: [
            create(ui.DiagnosticsCoverageSchema, { startMs: BigInt(at), endMs: BigInt(at + resolution * 1000) }),
          ],
          series: process.series.map((series) => ({
            ...series,
            started: series.started * BigInt(factor),
            completed: series.completed * BigInt(factor),
            codes: [12n * BigInt(factor)],
            duration: series.duration
              ? {
                  ...series.duration,
                  counts: series.duration.counts.map((n) => n * BigInt(factor)),
                  sum: series.duration.sum * factor,
                }
              : undefined,
          })),
        });

        const bytes = encodeRollup([value]);
        payloadBytes += bytes.length;

        return { at, bytes: Buffer.from(bytes).toString("hex") };
      });

      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload,compacted)
          SELECT ${owner}::uuid,'local',${resolution},to_timestamp(v.at::double precision/1000.0),decode(v.bytes,'hex'),true
          FROM unnest(${values.map((value) => value.at.toString())}::text[],${values.map((value) => value.bytes)}::text[]) v(at,bytes)`;
        }),
      );
    }

    if (env["CANOPY_BENCH_COMPACTION"] === "1")
      await store.query(
        `UPDATE diagnostics_rollups SET compacted=false WHERE owner_user_id=$1::uuid AND resolution=60
        AND bucket_start>=date_trunc('hour',now())-interval '1 hour' AND bucket_start<date_trunc('hour',now())`,
        [owner],
      );

    return {
      minuteRows: 120,
      hourRows: 720,
      methods: process.series.length,
      nonzeroDurationBuckets: duration.indices.length,
      payloadBytes,
    };
  } finally {
    await runtime.dispose();
  }
}
