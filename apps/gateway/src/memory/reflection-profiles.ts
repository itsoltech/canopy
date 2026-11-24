import { supportsIsolatedRuns } from "@canopy/domain/harnesses";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { applyInstanceModels, InstanceStore, ModelStore } from "../store/index.ts";
import { NATIVE_ID } from "../store/instance-config.ts";

function reflectionWorkers(sql: SqlClient.SqlClient, owner: string, ids?: readonly string[], lockVersion?: bigint) {
  return sql<{ id: string; name: string; version: bigint }>`SELECT w.id,w.name,c.version
    FROM workers w JOIN worker_configs c ON c.worker_id=w.id
    WHERE w.owner_user_id=${owner}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL
      AND c.applied_ok AND c.applied_version=c.version
      ${ids ? sql`AND w.id=ANY(${ids}::uuid[])` : sql``}
      ${lockVersion === undefined ? sql`ORDER BY w.name,w.id` : sql`AND c.version=${lockVersion} FOR SHARE OF w,c`}`;
}

export function lockReflectionWorker(sql: SqlClient.SqlClient, owner: string, worker: { id: string; version: bigint }) {
  return reflectionWorkers(sql, owner, [worker.id], worker.version).pipe(Effect.map((rows) => rows.length > 0));
}

/** Settings can use persisted catalogs offline. Dispatch supplies only live, generation-capable worker IDs. */
export function reflectionProfiles(sql: SqlClient.SqlClient, owner: string, ids?: readonly string[]) {
  return Effect.gen(function* () {
    const workers = yield* reflectionWorkers(sql, owner, ids);

    if (!workers.length) return [];
    const instances = yield* InstanceStore.use((store) => store.workerInstances());

    const catalogs = yield* ModelStore.use((store) =>
      store.catalogs(
        owner,
        workers.map((w) => w.id),
      ),
    );

    const rules = yield* InstanceStore.use((store) => store.modelRules());
    const byWorker = new Map(catalogs.map((catalog) => [catalog.workerId, catalog]));

    return workers.flatMap((row) => {
      const worker = { ...row, version: BigInt(row.version) };
      const catalog = byWorker.get(worker.id);

      if (catalog?.configVersion !== worker.version) return [];
      const assigned = instances.get(worker.id);

      return applyInstanceModels(catalog, rules)
        .profiles.filter(
          (profile) =>
            supportsIsolatedRuns(profile.provider) &&
            assigned?.some(
              (instance) =>
                instance.harness === profile.provider &&
                instance.id === (profile.profileId || NATIVE_ID) &&
                instance.enabled &&
                instance.available,
            ),
        )
        .map((profile) => ({ worker, profile }));
    });
  });
}
