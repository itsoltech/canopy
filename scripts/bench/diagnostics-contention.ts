import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import type { BenchPostgres } from "./diagnostics-postgres.ts";

/** Locks only the disposable benchmark DB. Application reads continue during a failed minute write. */
export async function diagnosticsContention(
  postgres: BenchPostgres,
  database: string,
  phase: string,
  api: Client<typeof ui.GatewayService>,
  thread: string,
  evidence?: (point: string) => Promise<object>,
) {
  if (phase !== "write_failure" && phase !== "pool_contention") return;

  const query = async (text: string) => {
    return (await postgres.query(database, text)).trim();
  };

  const lock =
    phase === "write_failure"
      ? "LOCK TABLE diagnostics_state IN EXCLUSIVE MODE"
      : `SELECT id FROM threads WHERE id='${thread}'::uuid FOR UPDATE`;

  if (phase === "write_failure") await evidence?.("before_lock");

  const holder = query(
    `SET application_name='canopy-diagnostics-contention'; BEGIN; ${lock}; SELECT pg_sleep(70); COMMIT;`,
  );

  const deadline = Date.now() + 10_000;

  while (
    (await query(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='canopy-diagnostics-contention' AND wait_event='PgSleep'",
    )) !== "1"
  ) {
    if (Date.now() > deadline) throw new Error("Contention lock was not acquired");
    await Bun.sleep(50);
  }

  // The default pool has ten slots: nine blocked updates leave one for reads and diagnostics.
  const updates =
    phase === "pool_contention"
      ? Promise.all(
          Array.from({ length: 9 }, (_, index) =>
            api.updateThread({ threadId: thread, title: `Pool contender ${index}` }),
          ),
        )
      : Promise.resolve([]);

  if (phase === "pool_contention")
    while (
      Number(
        await query(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND application_name='canopy-gateway'",
        ),
      ) < 9
    ) {
      if (Date.now() > deadline) throw new Error("Nine blocked gateway connections were not observed");
      await Bun.sleep(50);
    }

  const during = Bun.sleep(65_000).then(() => api.getComputerDiagnostics({ limit: 1 }));
  const lockAcquiredAtMs = Date.now();
  let lockReleasedAtMs = 0;

  const lockedHeap =
    evidence && phase === "write_failure" ? Bun.sleep(65_000).then(() => evidence("lock_end")) : Promise.resolve();

  const releasedHeap =
    evidence && phase === "write_failure"
      ? holder
          .then(() => {
            lockReleasedAtMs = Date.now();

            return Bun.sleep(20_000);
          })
          .then(() => evidence("released_twenty_seconds"))
      : Promise.resolve();

  return async () => {
    await holder;
    await updates;
    await lockedHeap;
    await releasedHeap;
    const interrupted = await during;
    const recovered = await api.getComputerDiagnostics({ limit: 1 });

    return {
      lockSeconds: 70,
      forensic: evidence ? { lockAcquiredAtMs, lockReleasedAtMs } : undefined,
      blockedGatewayConnections: phase === "pool_contention" ? 9 : 0,
      duringPersistenceStatus: interrupted.persistenceStatus,
      recoveredPersistenceStatus: recovered.persistenceStatus,
      pendingMinutes: recovered.pendingMinutes,
    };
  };
}
