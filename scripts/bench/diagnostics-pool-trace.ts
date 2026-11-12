import type { BenchPostgres } from "./diagnostics-postgres.ts";

/** Focused forensic mode only. Never captures SQL, bind values, errors or application data. */
export async function tracePool(postgres: BenchPostgres, database: string, workload: string) {
  if (process.env["CANOPY_BENCH_POOL_TRACE"] !== "1") return async () => {};

  let pending: Promise<void> | undefined;
  let failed = false;

  const sample = async () => {
    const states = await postgres.query(
      database,
      `SELECT coalesce(json_agg(json_build_object(
      'pid',pid,'state',state,'waitType',wait_event_type,'wait',wait_event,
      'ageMs',round(extract(epoch FROM (clock_timestamp()-query_start))*1000),
      'blockers',pg_blocking_pids(pid))), '[]'::json)::text
      FROM pg_stat_activity WHERE datname=current_database() AND application_name='canopy-gateway'`,
    );

    console.info(JSON.stringify({ phase: "pool_trace", workload, atMs: Date.now(), states }));
  };

  await sample();

  const timer = setInterval(() => {
    pending ??= sample()
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        pending = undefined;
      });
  }, 2000);

  return async () => {
    clearInterval(timer);
    await pending;

    if (failed) throw new Error("External pool trace failed");
  };
}
