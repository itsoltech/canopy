import { Data, Effect, Option } from "effect";
import type { SqlClient, SqlConnection } from "effect/sql";

/** Explicitly selected high-volume Canopy relations; no arbitrary identifiers or ALL mode. */
export const RECLAIM_TABLES: readonly string[] = [
  "thread_events",
  "thread_items",
  "blobs",
  "thread_blobs",
  "worker_commands",
  "bot_harness_events",
  "bot_messages",
  "computer_thread_changes",
  "computer_mirror_threads",
  "computer_thread_panels",
  "computer_shared_items",
  "thread_replication_journal",
  "thread_replication_seed_entities",
  "thread_replication_content",
  "thread_range_entities",
  "github_pr_cache",
  "diagnostics_rollups",
];

export class StorageReclaimRefused extends Data.TaggedError("StorageReclaimRefused")<{
  readonly message: string;
}> {}

export function reclaimSelectionError(offline: boolean, tables: readonly string[]): string | undefined {
  if (!offline) return "Reclaim requires --offline and a stopped gateway; prevent clients from reconnecting.";

  if (!tables.length) return "Reclaim requires at least one explicit --table selection.";

  if (tables.some((table) => !RECLAIM_TABLES.includes(table)))
    return "A selected table is outside the reclaim allowlist.";

  return undefined;
}

function requireExclusiveSession(connection: SqlConnection.Connection) {
  return Effect.gen(function* () {
    // Count all sessions, even idle clients and sessions whose details this role cannot read.
    const sessions: readonly { present: boolean }[] = yield* connection.executeUnprepared(
      `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
       WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database())
         AND pid<>pg_backend_pid()) AS present`,
      [],
      undefined,
    );

    if (sessions[0]?.present)
      return yield* Effect.fail(
        new StorageReclaimRefused({
          message: "Other database sessions are connected. Stop them and prevent reconnection; none were terminated.",
        }),
      );
  });
}

/** Reserve one backend for checks and VACUUM. The caller must prevent new connections throughout the window. */
export const reclaimStorage = (sql: SqlClient.SqlClient, offline: boolean, tables: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const problem = reclaimSelectionError(offline, tables);

      if (problem) return yield* Effect.fail(new StorageReclaimRefused({ message: problem }));

      if (sql.driver !== "pg")
        return yield* Effect.fail(new StorageReclaimRefused({ message: "Reclaim requires the PostgreSQL driver." }));

      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* Effect.fail(new StorageReclaimRefused({ message: "Reclaim must run outside a transaction." }));

      const connection = yield* sql.reserve;
      const selected = [...new Set(tables)];

      yield* requireExclusiveSession(connection);
      // Preflight every selection before rewriting any table. VACUUM can otherwise silently skip a table.

      for (const table of selected) {
        const rows: readonly { permitted: boolean }[] = yield* connection.executeUnprepared(
          `SELECT has_table_privilege(c.oid,'MAINTAIN') AS permitted
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname=$1 AND c.relkind='r'`,
          [table],
          undefined,
        );

        if (!rows[0]?.permitted)
          return yield* Effect.fail(
            new StorageReclaimRefused({
              message: `Cannot reclaim public.${table}: missing ordinary table or MAINTAIN privilege.`,
            }),
          );
      }

      yield* connection.executeUnprepared("SET lock_timeout='2s'", [], undefined);

      for (const table of selected) {
        yield* requireExclusiveSession(connection);
        // Only literals from RECLAIM_TABLES reach this identifier; one standalone command per relation.
        yield* connection.executeUnprepared(`VACUUM (FULL, ANALYZE) public."${table}"`, [], undefined);
      }

      return { reclaimed: selected };
    }),
  );
