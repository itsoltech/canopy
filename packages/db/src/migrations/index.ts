/// <reference path="../sql-modules.d.ts" />
import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import init from "./0001_init.sql" with { type: "text" };
import workerConfig from "./0002_worker_config.sql" with { type: "text" };
import gatewayRuntime from "./0003_gateway_runtime.sql" with { type: "text" };
import agentBusRuntime from "./0004_agent_bus_runtime.sql" with { type: "text" };
import settings from "./0005_settings.sql" with { type: "text" };
import turnSources from "./0006_turn_sources.sql" with { type: "text" };
import turnSourceDetails from "./0007_turn_source_details.sql" with { type: "text" };
import oneStartPerTurn from "./0008_one_start_per_turn.sql" with { type: "text" };
import modelsEffortSteer from "./0009_models_effort_steer.sql" with { type: "text" };
import goalsBackgroundHarness from "./0010_goals_background_harness.sql" with { type: "text" };
import goalsEngineCleanup from "./0011_goals_engine_cleanup.sql" with { type: "text" };
import workerRestart from "./0012_worker_restart.sql" with { type: "text" };
import turnEndSources from "./0013_turn_end_sources.sql" with { type: "text" };
import turnPermissionMode from "./0014_turn_permission_mode.sql" with { type: "text" };
import providerProfiles from "./0015_provider_profiles.sql" with { type: "text" };
import attachments from "./0016_attachments.sql" with { type: "text" };
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
  "0005_settings": sqlFile(settings),
  "0006_turn_sources": sqlFile(turnSources),
  "0007_turn_source_details": sqlFile(turnSourceDetails),
  "0008_one_start_per_turn": sqlFile(oneStartPerTurn),
  "0009_models_effort_steer": sqlFile(modelsEffortSteer),
  "0010_goals_background_harness": sqlFile(goalsBackgroundHarness),
  "0011_goals_engine_cleanup": sqlFile(goalsEngineCleanup),
  "0012_worker_restart": sqlFile(workerRestart),
  "0013_turn_end_sources": sqlFile(turnEndSources),
  "0014_turn_permission_mode": sqlFile(turnPermissionMode),
  "0015_provider_profiles": sqlFile(providerProfiles),
  "0016_attachments": sqlFile(attachments),
});

/** Applies pending migrations in a transaction with a lock, safe to call from a deploy step. */
export const migrate = Migrator.make({})({ loader: migrations, table: "schema_migrations" });
