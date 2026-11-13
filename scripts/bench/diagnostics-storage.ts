import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { gatewayRuntime, ensureDevUser } from "../../apps/gateway/src/runtime.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { RPC_METHODS } from "../../apps/gateway/src/diagnostics/registry.ts";

/** Resource-only evidence, not CPU/p95 acceptance. Query logical payload separately from table size. */
export async function diagnosticsStorage(env: Record<string, string | undefined>) {
  const runtime = gatewayRuntime(env);

  try {
    const owner = await ensureDevUser(runtime, "dev@localhost");
    const store = new DiagnosticsStore(runtime, owner, "local");

    return await store.query<{
      resolution: number;
      rows: number;
      payload_bytes: string;
      min_bytes: number;
      max_bytes: number;
    }>(
      `SELECT resolution,count(*)::int AS rows,sum(octet_length(payload))::text AS payload_bytes,
        min(octet_length(payload))::int AS min_bytes,max(octet_length(payload))::int AS max_bytes
       FROM diagnostics_rollups WHERE owner_user_id=$1::uuid AND computer_id=$2 GROUP BY resolution ORDER BY resolution`,
      [owner, "local"],
    );
  } finally {
    await runtime.dispose();
  }
}

async function auditWrites(store: DiagnosticsStore) {
  // Only the disposable DB, after all sampled processes close. Trigger overhead is never timed.
  await store.query("CREATE TABLE diagnostics_write_audit(label text PRIMARY KEY, changes int NOT NULL)");
  await store.query(`CREATE FUNCTION diagnostics_count_write() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE write_label text;
    BEGIN
      IF NEW.computer_id <> 'write-accounting' THEN RETURN NEW; END IF;
      IF TG_TABLE_NAME='diagnostics_rollups' THEN write_label := 'rollup_' || NEW.resolution::text;
      ELSE write_label := 'state'; END IF;
      INSERT INTO diagnostics_write_audit VALUES(write_label,1)
        ON CONFLICT(label) DO UPDATE SET changes=diagnostics_write_audit.changes+1;
      RETURN NEW;
    END $$`);

  for (const table of ["diagnostics_state", "diagnostics_rollups"])
    await store.query(`CREATE TRIGGER diagnostics_count_write AFTER INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION diagnostics_count_write()`);
}

/** Sixty actual SQL batches representing sixty minutes; timestamps deliberately exercise late-hour replacement. */
export async function diagnosticsWrites(env: Record<string, string | undefined>) {
  const runtime = gatewayRuntime(env);

  try {
    const owner = await ensureDevUser(runtime, "dev@localhost");
    const store = new DiagnosticsStore(runtime, owner, "write-accounting");
    const state = create(ui.DiagnosticsStateSchema, { schemaVersion: 1, epoch: crypto.randomUUID() });
    await store.initialize(state);
    await auditWrites(store);
    const method = RPC_METHODS.find((method) => method.name.endsWith("/GetThread"));

    if (!method) throw new Error("Benchmark descriptor unavailable");
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;

    for (let minute = 0; minute < 60; minute++) {
      const at = hour + minute * 60_000;

      const process = create(ui.DiagnosticsProcessSchema, {
        processId: "gateway",
        session: "write-accounting",
        sequence: BigInt(at),
        series: [
          {
            methodId: method.id,
            started: 1n,
            completed: 1n,
            codes: [1n],
            duration: { indices: [41], counts: [1n], sum: 1, max: 1 },
          },
        ],
        coverage: [{ startMs: BigInt(at), endMs: BigInt(at + 60_000) }],
      });

      await store.write([{ at, processes: [process] }], state);
    }

    const changes = await store.query<{ label: string; changes: number }>(
      "SELECT label,changes FROM diagnostics_write_audit ORDER BY label",
    );

    const rows = await store.query<{ resolution: number; rows: number; payload_bytes: string }>(
      `SELECT resolution,count(*)::int AS rows,sum(octet_length(payload))::text AS payload_bytes
       FROM diagnostics_rollups WHERE owner_user_id=$1::uuid AND computer_id=$2 GROUP BY resolution ORDER BY resolution`,
      [owner, "write-accounting"],
    );

    return {
      simulatedMinutes: 60,
      batches: 60,
      changes,
      rows,
      scenario: "late minutes in one completed hour; repeated hourly replacement, not elapsed-hour timing",
    };
  } finally {
    await runtime.dispose();
  }
}
