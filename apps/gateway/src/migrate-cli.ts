import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { migrate, migrateOnline, POSTGRES_MAX_MESSAGE_BYTES } from "@canopy/db";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { databaseUrl, provisionedPassword } from "./database-credentials.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function selectedMigration(env: Environment) {
  const mode = env["CANOPY_DATABASE_INDEX_MODE"] ?? "blocking";

  if (mode !== "blocking" && mode !== "concurrent")
    throw new Error("CANOPY_DATABASE_INDEX_MODE must be blocking or concurrent");

  return mode === "concurrent" ? migrateOnline : migrate;
}

// PostgreSQL's SCRAM verifier format. Only this verifier goes to the database,
// including when the operator enables full statement and parameter logging.
function verifier(password: string): string {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");

  const stored = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest("base64");

  const server = createHmac("sha256", salted).update("Server Key").digest("base64");

  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored}:${server}`;
}

export function provisionRuntime(password: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET LOCAL search_path=pg_catalog`;
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.runtime_role',0))`;
        yield* sql`DO $role$ DECLARE marker text := 'Canopy gateway runtime for ' || current_database();
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='canopy_runtime') THEN
            CREATE ROLE canopy_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
            EXECUTE format('COMMENT ON ROLE canopy_runtime IS %L',marker);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='canopy_runtime' AND r.rolcanlogin
              AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
              AND shobj_description(r.oid,'pg_authid')=marker
              AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))
            OR has_schema_privilege('canopy_runtime','public','CREATE')
            OR has_database_privilege('canopy_runtime',current_database(),'CREATE') THEN
            RAISE EXCEPTION 'Cannot provision an unrelated or privileged runtime role';
          END IF;
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO canopy_runtime',current_database());
        END $role$`;
        // All application relations in the dedicated Canopy database live in public.
        // Reapply after each migration, including when only index work remained on a retry.
        yield* sql`GRANT USAGE ON SCHEMA public TO canopy_runtime`;
        yield* sql`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO canopy_runtime`;
        yield* sql`REVOKE ALL PRIVILEGES ON public.schema_migrations FROM canopy_runtime`;
        yield* sql`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO canopy_runtime`;
        yield* sql`SELECT set_config('canopy.runtime_verifier',${verifier(password)},true)`;
        yield* sql`DO $password$ BEGIN
        EXECUTE format('ALTER ROLE canopy_runtime PASSWORD %L',current_setting('canopy.runtime_verifier'));
      END $password$`;
      }),
    );
  });
}

/** A deploy step requiring only database credentials. Never starts the gateway or its supervisor. */
export async function migrateCli(args: readonly string[], env: Environment): Promise<number> {
  if (args.length) {
    console.error("Usage: canopy-gateway migrate");

    return 64;
  }

  try {
    const url = databaseUrl(env);
    const password = provisionedPassword(env, url);

    const applied = await Effect.runPromise(
      Effect.gen(function* () {
        const changes = yield* selectedMigration(env);

        if (password !== undefined) yield* provisionRuntime(password);

        return changes.length;
      }).pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(url),
            applicationName: "canopy-migrate",
            maxMessageSize: POSTGRES_MAX_MESSAGE_BYTES,
          }),
        ),
      ),
    );

    console.info(`Database ready (${applied} migrations applied).`);

    return 0;
  } catch {
    console.error(
      "Database migration failed. Check the migration connection, runtime role and PostgreSQL permissions.",
    );

    return 1;
  }
}
