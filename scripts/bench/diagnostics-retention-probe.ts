import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../../apps/gateway/src/core/core-context.ts";
import { queryFamily } from "../../apps/gateway/src/diagnostics/query-context.ts";

/** Fail a real owner-scoped write with an 8 MiB JSON parameter; discard the entire failure immediately. */
export async function failedParameterWrite(runtime: CoreRuntime, owner: string) {
  if (!process.env["CANOPY_BENCH_FORENSICS_DIR"] || process.env["CANOPY_BENCH_RETENTION_PROBE"] !== "1")
    throw new Error("The failed-parameter probe is forensic-only");

  const failed = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const payload = JSON.stringify({ synthetic: "x".repeat(8 * 1024 * 1024) });

      return Exit.isFailure(
        yield* Effect.exit(sql`
        INSERT INTO diagnostics_state(owner_user_id,computer_id,payload,persisted_through)
        VALUES (${owner}::uuid,'retention-probe',${new Uint8Array(0)},${payload}::timestamptz)`),
      );
    }).pipe(queryFamily("diagnostics.write")),
  );

  if (!failed) throw new Error("The failed-parameter probe unexpectedly succeeded");
}
