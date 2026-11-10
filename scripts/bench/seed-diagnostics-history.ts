import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram } from "@canopy/domain/diagnostics";
import { gatewayRuntime, ensureDevUser } from "../../apps/gateway/src/runtime.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { RPC_METHODS } from "../../apps/gateway/src/diagnostics/registry.ts";
import { encodeRollup } from "../../apps/gateway/src/diagnostics/rollup.ts";

/** Fill a newly created private benchmark DB to both production retention quotas. */
export async function seedDiagnosticsHistory(env: Record<string, string | undefined>) {
  const runtime = gatewayRuntime(env);

  try {
    const owner = await ensureDevUser(runtime, "dev@localhost");
    const store = new DiagnosticsStore(runtime, owner, "local");
    const duration = new Histogram();

    for (let index = 0; index < 128; index++) duration.record(0.001 * 2 ** (index / 4));

    const process = create(ui.DiagnosticsProcessSchema, {
      processId: "gateway",
      session: "synthetic-history",
      sequence: 1n,
      series: RPC_METHODS.filter((method) => !method.stream)
        .slice(0, 80)
        .map((method) => ({
          methodId: method.id,
          started: 128n,
          completed: 128n,
          codes: [128n],
          duration: duration.snapshot(),
        })),
    });

    const payload = encodeRollup([process]);
    await store.initialize(create(ui.DiagnosticsStateSchema, { schemaVersion: 1, epoch: crypto.randomUUID() }));
    // The newest bucket is replaced by the running collector; quotas include that minute/hour.
    await store.query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload,compacted)
      SELECT $1::uuid,'local',60,date_trunc('minute',now())-n*interval '1 minute',$2,true FROM generate_series(0,4319) n`,
      [owner, payload],
    );
    await store.query(
      `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload,compacted)
      SELECT $1::uuid,'local',3600,date_trunc('hour',now())-n*interval '1 hour',$2,true FROM generate_series(0,719) n`,
      [owner, payload],
    );

    return { minuteRows: 4320, hourRows: 720, payloadBytes: payload.length };
  } finally {
    await runtime.dispose();
  }
}
