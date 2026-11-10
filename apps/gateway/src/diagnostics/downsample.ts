import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { compactRollups, decodeRollup, encodeRollup } from "./rollup.ts";

export type RollupRow = {
  owner_user_id: string;
  computer_id: string;
  resolution: number;
  bucket_start: Date;
  payload: Uint8Array;
  compacted: boolean;
};

/** Under the home-state lock; re-build closed hours, never add an already counted minute. */
export const downsampleWrite = (sql: SqlClient.SqlClient, minutes: RollupRow[], now: number) =>
  Effect.gen(function* () {
    const first = minutes[0];

    if (!first) return [];
    const currentHour = Math.floor(now / 3_600_000) * 3_600_000;

    const hours = new Set(
      minutes.flatMap((row) => {
        const hour = Math.floor(row.bucket_start.getTime() / 3_600_000) * 3_600_000;

        return hour < currentHour ? [hour] : [];
      }),
    );

    if (hours.size > 2) throw new Error("Diagnostics write age exceeds budget");
    const result: RollupRow[] = [];

    for (const at of hours) {
      const rows = yield* sql<{
        bucket_start: Date;
        payload: Uint8Array;
      }>`SELECT bucket_start,payload FROM diagnostics_rollups
      WHERE owner_user_id=${first.owner_user_id}::uuid AND computer_id=${first.computer_id} AND resolution=60
      AND bucket_start>=${new Date(at)} AND bucket_start<${new Date(at + 3_600_000)} ORDER BY bucket_start LIMIT 60`;

      const values = new Map(rows.map((row) => [new Date(row.bucket_start).getTime(), row.payload]));

      for (const row of minutes)
        if (row.bucket_start.getTime() >= at && row.bucket_start.getTime() < at + 3_600_000) {
          values.set(row.bucket_start.getTime(), row.payload);
          row.compacted = true;
        }

      const payload = encodeRollup(compactRollups([...values.values()].map(decodeRollup)));
      result.push({ ...first, resolution: 3600, bucket_start: new Date(at), payload, compacted: true });
    }

    if (result.length) {
      const quota = yield* sql<{ n: number }>`SELECT count(*)::int n FROM diagnostics_rollups
      WHERE owner_user_id=${first.owner_user_id}::uuid AND computer_id=${first.computer_id} AND resolution=3600
      AND NOT (bucket_start=ANY(${result.map((row) => row.bucket_start)}::timestamptz[]))`;

      if ((quota[0]?.n ?? 0) + result.length > 720) throw new Error("Diagnostics hourly retention quota reached");
    }

    return result;
  });
