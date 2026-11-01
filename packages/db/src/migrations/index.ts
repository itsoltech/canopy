/// <reference path="../sql-modules.d.ts" />
import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import init from "./0001_init.sql" with { type: "text" };
import workerConfig from "./0002_worker_config.sql" with { type: "text" };
import gatewayRuntime from "./0003_gateway_runtime.sql" with { type: "text" };
import agentBusRuntime from "./0004_agent_bus_runtime.sql" with { type: "text" };
import { splitStatements } from "./split.ts";

/**
 * Runs a .sql file statement by statement (the driver uses the extended protocol only).
 * Migrations stay plain SQL so they can be reviewed and replayed with psql.
 * The migrator wraps each migration in a transaction.
 */
const sqlFile = (content: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of splitStatements(content)) {
      yield* sql.unsafe(statement).raw;
    }
  });

/** Ordered by the numeric prefix. Never edit an applied migration; add a new one (expand/contract). */
export const migrations = Migrator.fromRecord({
  "0001_init": sqlFile(init),
  "0002_worker_config": sqlFile(workerConfig),
  "0003_gateway_runtime": sqlFile(gatewayRuntime),
  "0004_agent_bus_runtime": sqlFile(agentBusRuntime),
});

/** Applies pending migrations in a transaction with a lock, safe to call from a deploy step. */
export const migrate = Migrator.make({})({ loader: migrations, table: "schema_migrations" });
