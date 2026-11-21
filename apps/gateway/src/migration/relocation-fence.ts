import { Schema } from "effect";
import { DatabaseMigrationError, postgresOutput, psqlFlags, withPostgresConnection } from "./postgres-tools.ts";

export const relocationTable = "public.gateway_relocation_fence";
export const relocationOperatorLock = "canopy.gateway_relocation.operator";
export const relocationRuntimeLock = "canopy.gateway_relocation.runtime";
export const relocationShutdownLock = "canopy.gateway_relocation.shutdown";

// A queued turn or an unsent outbox command can resume on the destination. In particular, an
// attempted StartTurn with a lost command response can wake a harness before we receive turn_started.
export const relocationIdle = `NOT EXISTS (SELECT FROM public.turns WHERE status = 'running')
  AND NOT EXISTS (SELECT FROM public.bot_turns WHERE status = 'running')
  AND NOT EXISTS (SELECT FROM public.thread_items WHERE type = 'background_task' AND status = 'in_progress')
  AND NOT EXISTS (
    SELECT FROM public.worker_commands c JOIN public.turns t ON t.id = c.turn_id
    WHERE c.kind = 'startTurn' AND c.status IN ('delivered', 'completed') AND t.status = 'queued'
  )`;

const offline = `NOT EXISTS (SELECT FROM pg_catalog.pg_stat_activity WHERE datname = current_database()
    AND pid <> pg_backend_pid())
  AND NOT EXISTS (SELECT FROM pg_catalog.pg_prepared_xacts WHERE database = current_database())`;

const read = `SELECT operation_id::text || ' ' || state FROM ${relocationTable}`;
const restored = (id: string) => `EXISTS (SELECT FROM public.gateway_relocation_receipts WHERE run_id = '${id}')`;
const stateSchema = Schema.Literals(["draining", "drained", "committed"]);
const decodeState = Schema.decodeUnknownSync(stateSchema);

export type RelocationFence = { operationId: string; state: typeof stateSchema.Type };

function requireOperationId(id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new DatabaseMigrationError("A gateway relocation operation requires a UUID.");

  return id.toLowerCase();
}

function parseFence(output: string): RelocationFence | undefined {
  if (!output) return undefined;
  const [operationId, state] = output.split(" ");

  return { operationId: requireOperationId(operationId ?? ""), state: decodeState(state) };
}

function operator(env: NodeJS.ProcessEnv, query: string) {
  return withPostgresConnection(env, (connection) =>
    postgresOutput(
      "psql",
      [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--file=-"],
      connection.env,
      "Could not access the gateway relocation fence. Check the admin connection and migration 0188.",
      `BEGIN;
SET LOCAL synchronous_commit = on;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${relocationOperatorLock}', 0)); END $$;
${query}
COMMIT;`,
    ),
  );
}

/** Persists the start fence before a running gateway begins to drain. */
export async function requestDrain(env: NodeJS.ProcessEnv, operationId: string): Promise<void> {
  const id = requireOperationId(operationId);

  const output = await operator(
    env,
    `INSERT INTO ${relocationTable} AS f (operation_id, state)
     SELECT '${id}'::uuid, 'draining' WHERE NOT ${restored(id)}
     ON CONFLICT (singleton) DO UPDATE SET operation_id = EXCLUDED.operation_id
     WHERE f.operation_id = EXCLUDED.operation_id RETURNING operation_id;`,
  );

  if (!output) throw new DatabaseMigrationError("A different operation already fenced this gateway.");
}

/** The admin connection alone promotes a quiet, stopped source to drained. It can also inspect an empty target. */
export async function readFence(env: NodeJS.ProcessEnv): Promise<RelocationFence | undefined> {
  const output = await operator(
    env,
    String.raw`SELECT to_regclass('${relocationTable}') IS NOT NULL AS fence_exists \gset
\if :fence_exists
  UPDATE ${relocationTable} SET state = 'drained' WHERE state = 'draining'
    AND pg_try_advisory_xact_lock(hashtextextended('${relocationRuntimeLock}', 0))
    AND ${offline} AND ${relocationIdle};
  ${read};
\endif`,
  );

  return parseFence(output);
}

/** The original source remains fenced permanently after the coordinator commits it. */
export async function commitSourceFence(env: NodeJS.ProcessEnv, operationId: string): Promise<void> {
  const id = requireOperationId(operationId);

  const output = await operator(
    env,
    `UPDATE ${relocationTable} SET state = 'committed' WHERE operation_id = '${id}'
      AND NOT ${restored(id)}
      AND (state = 'committed' OR (state = 'drained' AND ${offline} AND ${relocationIdle}))
      RETURNING operation_id;`,
  );

  if (!output) throw new DatabaseMigrationError("Only the matching offline and drained source can be committed.");
}

async function removeFence(env: NodeJS.ProcessEnv, operationId: string, imported: boolean) {
  const id = requireOperationId(operationId);
  const destination = imported ? restored(id) : `NOT ${restored(id)}`;
  const allowed = imported ? "state = 'drained'" : "state IN ('draining', 'drained')";

  const cleared = imported
    ? "'cleared'"
    : `CASE WHEN pg_try_advisory_xact_lock(hashtextextended('${relocationShutdownLock}', 0))
        THEN 'cleared' ELSE 'shutting_down' END`;

  const output = await operator(
    env,
    `DELETE FROM ${relocationTable} WHERE operation_id = '${id}' AND ${allowed} AND ${destination};
     SELECT CASE WHEN ${destination} AND NOT EXISTS (SELECT FROM ${relocationTable})
       THEN ${cleared} ELSE 'refused' END;`,
  );

  if (output !== "cleared" && output !== "shutting_down")
    throw new DatabaseMigrationError("The gateway relocation fence cannot be cleared in its current state.");

  return { shuttingDown: output === "shutting_down" };
}

/** The shutdown claim is observed in the same transaction that removes the source fence. */
export function abortFence(env: NodeJS.ProcessEnv, operationId: string): Promise<{ shuttingDown: boolean }> {
  return removeFence(env, operationId, false);
}

/** Only the coordinator that verified destination activation authorization may call this. */
export async function clearImportedFence(env: NodeJS.ProcessEnv, operationId: string): Promise<void> {
  await removeFence(env, operationId, true);
}
