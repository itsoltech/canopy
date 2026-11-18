import type { ModuleId } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient, type Statement } from "effect/sql";

export const BOT_THREADS_DISCONNECTED = "Enable both Threads and Bots in Settings to use this connection.";

export const moduleDisabledMessage = (module: ModuleId) =>
  `Enable ${module === "bots" ? "Bots" : "Threads"} in Settings to use this module.`;

/** A missing settings row or module section enables both modules on existing installations. */
function ownerModules(sql: SqlClient.SqlClient, owner: string | Statement.Fragment, required: readonly ModuleId[]) {
  return sql`NOT EXISTS (SELECT 1 FROM user_settings us WHERE us.user_id = ${owner}::uuid
    AND NOT (coalesce(us.settings #> '{modules,enabled}', '["threads","bots"]'::jsonb) @> ${JSON.stringify(required)}::jsonb))`;
}

export function ownerModule(sql: SqlClient.SqlClient, owner: string | Statement.Fragment, module: ModuleId) {
  return ownerModules(sql, owner, [module]);
}

export function botThreadConnection(sql: SqlClient.SqlClient, owner: string) {
  return ownerModules(sql, owner, ["threads", "bots"]);
}

const readEnabled = (sql: SqlClient.SqlClient, predicate: Statement.Fragment) =>
  sql<{ enabled: boolean }>`SELECT ${predicate} AS enabled`.pipe(Effect.map((rows) => rows[0]!.enabled));

export function ownerModuleEnabled(owner: string, module: ModuleId) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) => readEnabled(sql, ownerModule(sql, owner, module)));
}

export function botThreadConnectionEnabled(owner: string) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) => readEnabled(sql, botThreadConnection(sql, owner)));
}

const moduleLockKey = (sql: SqlClient.SqlClient, owner: string | Statement.Fragment) =>
  sql`hashtextextended('canopy.owner_modules:' || ${owner}::uuid::text, 0)`;

/** Acquire before the config clock or any work rows. Also protects an owner's first settings write. */
export function lockModuleChanges(sql: SqlClient.SqlClient, owner: string) {
  return sql`SELECT pg_advisory_xact_lock(${moduleLockKey(sql, owner)})`;
}

export function lockModuleAdmission(sql: SqlClient.SqlClient, owner: string | Statement.Fragment) {
  return sql`SELECT pg_advisory_xact_lock_shared(${moduleLockKey(sql, owner)})`;
}

/** Read after taking the lock, in a separate statement, so the snapshot includes a racing settings commit. */
export function lockedOwnerModule(sql: SqlClient.SqlClient, owner: string, module: ModuleId) {
  return Effect.andThen(lockModuleAdmission(sql, owner), readEnabled(sql, ownerModule(sql, owner, module)));
}

export function lockedBotThreadConnection(sql: SqlClient.SqlClient, owner: string) {
  return Effect.andThen(lockModuleAdmission(sql, owner), readEnabled(sql, botThreadConnection(sql, owner)));
}
