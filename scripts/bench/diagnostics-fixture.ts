import type { BenchPostgres } from "./diagnostics-postgres.ts";

export async function fixtureIdentity(
  postgres: BenchPostgres,
  database: string,
  pair: number,
  attempt: number,
  slotOn: boolean,
  enabled: boolean,
) {
  const counts = await postgres.query(
    database,
    process.env["CANOPY_BENCH_SOURCE_ROOT"]
      ? "SELECT (SELECT count(*) FROM threads),(SELECT count(*) FROM turns),(SELECT count(*) FROM thread_items),0"
      : "SELECT (SELECT count(*) FROM threads),(SELECT count(*) FROM turns),(SELECT count(*) FROM thread_items),(SELECT count(*) FROM diagnostics_rollups)",
  );

  console.info(
    JSON.stringify({
      phase: "fixture_identity",
      series: pair,
      attempt,
      slotOn,
      diagnosticsEnabled: enabled,
      database,
      driverPid: process.pid,
      stateDir: process.env["CANOPY_BENCH_STATE_DIR"],
      counts,
    }),
  );
}
