import { Effect } from "effect";
import type { Database } from "./consolidation-catalog.ts";
import { consolidationError } from "./consolidation-types.ts";

export const selectedOwner = (env: NodeJS.ProcessEnv) => env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost";

export function assertProjectionOffline(sql: Database, operationId: string, allowCommitted: boolean) {
  return Effect.gen(function* () {
    yield* sql`SELECT pg_stat_clear_snapshot()`;

    const [state] = yield* sql<{ allowed: boolean }>`SELECT
      EXISTS (SELECT FROM public.gateway_relocation_fence WHERE singleton AND operation_id=${operationId}::uuid
        AND (state='drained' OR (state='committed' AND ${allowCommitted})))
      AND NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database()
        AND backend_type='client backend' AND pid<>pg_backend_pid())
      AND NOT EXISTS (SELECT FROM pg_prepared_xacts WHERE database=current_database()) AS allowed`;

    if (!state?.allowed)
      return yield* Effect.fail(
        consolidationError("Keep the matching source gateway offline and drain it before finalizing the projection."),
      );
  });
}
