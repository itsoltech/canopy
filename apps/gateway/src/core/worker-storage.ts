import { Effect, Match } from "effect";
import { SqlClient } from "effect/sql";
import { Provider, type ThreadStorageCleanupReply } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

/** Only the authoritative, permanently purged source may release its exact local scope. */
export const purgedWorkerStorage = (
  owner: string,
  worker: string,
  completed: readonly string[],
  deferred: readonly string[] = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<{ id: string; provider: string; provider_profile_id: string | null; sessions: string[] }>`
      SELECT t.id,t.provider,t.provider_profile_id,ARRAY(SELECT DISTINCT session FROM (
        SELECT t.provider_thread_id AS session
        UNION ALL SELECT provider_session_id FROM turns WHERE thread_id=t.id
        UNION ALL SELECT source_provider_thread_id FROM thread_rewinds WHERE thread_id=t.id
        UNION ALL SELECT replacement_provider_thread_id FROM thread_rewinds WHERE thread_id=t.id
      ) candidates WHERE session IS NOT NULL AND session<>'' AND NOT EXISTS (
        SELECT 1 FROM threads live WHERE live.id<>t.id AND live.worker_id=t.worker_id AND live.provider=t.provider
          AND live.purge_completed_at IS NULL AND (live.provider_thread_id=session
            OR EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=live.id AND u.provider_session_id=session)
            OR EXISTS(SELECT 1 FROM thread_rewinds r WHERE r.thread_id=live.id
              AND session IN (r.source_provider_thread_id,r.replacement_provider_thread_id)))
      )) AS sessions FROM threads t
      WHERE t.owner_user_id=${owner}::uuid AND t.worker_id=${worker}::uuid
        AND t.purge_completed_at IS NOT NULL AND t.moved_to IS NULL
        AND NOT(t.id=ANY(${[...completed]}::uuid[])) AND NOT(t.id=ANY(${[...deferred]}::uuid[]))
      ORDER BY t.purge_completed_at,t.id LIMIT 32`;

    return rows.map((row) => ({
      threadId: row.id,
      provider: Match.value(row.provider).pipe(
        Match.when("codex", () => Provider.CODEX),
        Match.when("claude", () => Provider.CLAUDE),
        Match.orElse(() => Provider.GROK),
      ),
      providerProfileId: row.provider_profile_id ?? "native",
      providerThreadIds: row.sessions,
    }));
  });

export async function offerWorkerStorage(core: GatewayCore, connection: WorkerConnection) {
  if (!connection.hello.capabilities.includes("thread_storage_cleanup_v1")) return;
  const pending = connection.storageCleanupPending;

  if (pending && Date.now() - pending.sentAt < 30_000) return;

  if (pending) {
    for (const id of pending.ids) connection.storageCleanupDeferred.add(id);
    connection.storageCleanupPending = undefined;
  }

  const options = core[coreState].options;

  const scopes = await options.runtime.runPromise(
    purgedWorkerStorage(
      options.userId,
      connection.workerId,
      [...connection.storageCleaned],
      [...connection.storageCleanupDeferred],
    ),
  );

  if (!scopes.length) {
    // A deferred batch gets one round out of the way for later candidates. If it is the only work left, retry it on
    // the next heartbeat after configuration/import ownership may have changed.
    connection.storageCleanupDeferred.clear();

    return;
  }

  if (core.link.connections.get(connection.workerId) !== connection || !connection.isOpen) return;
  const requestId = Bun.randomUUIDv7();
  connection.storageCleanupPending = { requestId, ids: scopes.map((scope) => scope.threadId), sentAt: Date.now() };
  connection.send({ case: "threadStorageCleanup", value: { requestId, scopes } });
}

export function completeWorkerStorage(connection: WorkerConnection, reply: ThreadStorageCleanupReply) {
  const pending = connection.storageCleanupPending;

  if (!pending || pending.requestId !== reply.requestId) return;
  const completed = new Set(reply.completedThreadIds);

  for (const id of pending.ids) {
    if (completed.has(id)) {
      connection.storageCleaned.add(id);
      connection.storageCleanupDeferred.delete(id);
    } else connection.storageCleanupDeferred.add(id);
  }

  connection.storageCleanupPending = undefined;
}
