import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Keep offering first-run setup across restarts of the initial version. */
export function offerGatewayOnboarding(version: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`
      UPDATE gateway_onboarding SET first_version = coalesce(first_version, ${version})
      WHERE first_version IS NULL OR first_version = ${version}
      RETURNING singleton
    `;

    return rows.length > 0;
  });
}
