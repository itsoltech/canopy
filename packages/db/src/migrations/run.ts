import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { reconcileDeferredIndexes } from "./deferred-indexes.ts";
import { splitStatements } from "./split.ts";

/**
 * Runs a .sql file statement by statement (the driver uses the extended protocol only).
 * Migrations stay plain SQL so they can be reviewed and replayed with psql.
 * The migrator wraps each migration in a transaction.
 */
export const sqlFile = (content: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (const statement of splitStatements(content)) {
      yield* sql.unsafe(statement).raw;
    }
  });

/** Applies pending migrations in a transaction with a lock, safe to call from a deploy step. */
export function createMigrator(loader: Migrator.Loader) {
  const migrateSchema = Migrator.make({})({ loader, table: "schema_migrations" });

  const migrateWithIndexes = (concurrent: boolean) =>
    Effect.gen(function* () {
      const applied = yield* migrateSchema;
      yield* reconcileDeferredIndexes(concurrent);

      return applied;
    });

  return { migrate: migrateWithIndexes(false), migrateOnline: migrateWithIndexes(true) };
}
