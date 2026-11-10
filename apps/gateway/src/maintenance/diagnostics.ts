import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { compactRollups, decodeRollup, encodeRollup } from "../diagnostics/rollup.ts";

/** Shares the durable maintenance lease. A late minute invalidates its hour via compacted=false. */
export const pruneDiagnostics = (sql: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    let touched =
      (yield* sql`DELETE FROM diagnostics_rollups WHERE (owner_user_id,computer_id,resolution,bucket_start) IN (
    SELECT owner_user_id,computer_id,resolution,bucket_start FROM diagnostics_rollups
    WHERE owner_user_id=${owner}::uuid AND resolution=3600 AND bucket_start<now()-interval '30 days'
    ORDER BY bucket_start LIMIT 64 FOR UPDATE SKIP LOCKED) RETURNING bucket_start`).length;

    const homes = yield* sql<{ computer_id: string }>`SELECT s.computer_id FROM diagnostics_state s
    WHERE s.owner_user_id=${owner}::uuid AND EXISTS (
      SELECT 1 FROM diagnostics_rollups r WHERE r.owner_user_id=s.owner_user_id AND r.computer_id=s.computer_id
      AND r.resolution=60 AND NOT r.compacted AND r.bucket_start<date_trunc('hour',now()))
    ORDER BY s.computer_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`;

    const computer = homes[0]?.computer_id;

    if (computer) {
      const hours = yield* sql<{ hour: Date }>`SELECT date_trunc('hour',bucket_start) AS hour FROM diagnostics_rollups
      WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=60 AND NOT compacted
      AND bucket_start<date_trunc('hour',now()) ORDER BY bucket_start LIMIT 1`;

      const hour = hours[0]?.hour;

      if (hour) {
        const rows = yield* sql<{ payload: Uint8Array }>`SELECT payload FROM diagnostics_rollups
        WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=60
        AND bucket_start>=${hour} AND bucket_start<${hour}+interval '1 hour' ORDER BY bucket_start LIMIT 60`;

        let bytes: Uint8Array;

        try {
          bytes = encodeRollup(compactRollups(rows.map((row) => decodeRollup(row.payload))));
        } catch {
          bytes = toBinary(
            ui.DiagnosticsRollupSchema,
            create(ui.DiagnosticsRollupSchema, { schemaVersion: 1, incomplete: true }),
          );
        }

        const saved =
          yield* sql`INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload,compacted)
        SELECT ${owner}::uuid,${computer},3600,${hour},${bytes},true WHERE
          (SELECT count(*) FROM diagnostics_rollups WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=3600)<720
          OR EXISTS(SELECT 1 FROM diagnostics_rollups WHERE owner_user_id=${owner}::uuid AND computer_id=${computer}
            AND resolution=3600 AND bucket_start=${hour})
        ON CONFLICT(owner_user_id,computer_id,resolution,bucket_start) DO UPDATE SET payload=EXCLUDED.payload RETURNING bucket_start`;

        if (saved.length)
          touched += (yield* sql`UPDATE diagnostics_rollups SET compacted=true
        WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=60
        AND bucket_start>=${hour} AND bucket_start<${hour}+interval '1 hour' RETURNING bucket_start`).length;
      }
    }

    touched +=
      (yield* sql`DELETE FROM diagnostics_rollups WHERE (owner_user_id,computer_id,resolution,bucket_start) IN (
    SELECT owner_user_id,computer_id,resolution,bucket_start FROM diagnostics_rollups
    WHERE owner_user_id=${owner}::uuid AND resolution=60 AND compacted AND bucket_start<now()-interval '2 hours'
    ORDER BY bucket_start LIMIT 131 FOR UPDATE SKIP LOCKED) RETURNING bucket_start`).length;

    return touched;
  });
