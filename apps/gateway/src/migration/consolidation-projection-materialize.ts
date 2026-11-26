import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { databaseUrl } from "../database-credentials.ts";
import {
  consolidationCatalog,
  databaseLayer,
  ident,
  publicTable,
  type Database,
  type SelectedTable,
} from "./consolidation-catalog.ts";
import {
  projectionBlockersTable,
  projectionFrames,
  projectionOperation,
  projectionOperationId,
  projectionSecretsTable,
  readProjectionManifest,
  type ProjectionManifest,
} from "./consolidation-projection-format.ts";
import { consolidationError } from "./consolidation-types.ts";
import { emptyDatabaseCheck } from "./postgres-target.ts";
import { DatabaseMigrationError } from "./postgres-tools.ts";

interface MaterializeOptions {
  targetDatabaseUrl: string;
  operationId: string;
}

const types =
  /^(?:bigint|boolean|bytea|character varying(?:\(\d+\))?|date|double precision|integer|interval|jsonb?|numeric(?:\(\d+,\d+\))?|real|smallint|text|time(?:stamp)?(?:\([0-6]\))? (?:without|with) time zone|tsvector|uuid)(?:\[\])?$/;

const additionalTables = {
  config_items: "owner_user_id uuid NOT NULL,kind text NOT NULL,local_id text NOT NULL,global_id text NOT NULL",
  computer_redirects:
    "owner_user_id uuid NOT NULL,kind text NOT NULL,item_id uuid NOT NULL,from_node_id text NOT NULL,home_node_id text NOT NULL,home_name text NOT NULL,moved_at timestamptz NOT NULL,basis text NOT NULL",
  [projectionBlockersTable]: "table_name text NOT NULL,item_key text NOT NULL,reason text NOT NULL",
  [projectionSecretsTable]:
    "table_name text NOT NULL,column_name text NOT NULL,source_key text NOT NULL,envelope_sha256 text NOT NULL CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$'),PRIMARY KEY(table_name,column_name,source_key)",
};

export function materializeConsolidationProjection(
  stagingEnv: NodeJS.ProcessEnv,
  directory: string,
  options: MaterializeOptions,
) {
  return projectionOperation(async () => {
    const manifest = await readProjectionManifest(directory);
    const operationId = projectionOperationId(options.operationId);
    const stagingUrl = databaseUrl(stagingEnv);

    if (manifest.operationId !== operationId || stagingUrl === options.targetDatabaseUrl)
      throw consolidationError("The projection requires the matching operation and a separate staging database.");

    const catalog = await Effect.runPromise(
      SqlClient.SqlClient.use(consolidationCatalog).pipe(
        Effect.provide(databaseLayer(options.targetDatabaseUrl, "canopy-projection-target-catalog")),
      ),
    );

    if (manifest.catalogSignature !== catalog.signature)
      throw consolidationError("The projection schema differs from the target release.");

    await Effect.runPromise(
      SqlClient.SqlClient.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertTrialDatabase(sql, manifest);
            yield* createProjectionTables(sql, manifest, catalog.selected);
            yield* loadProjectionRows(sql, directory, manifest, catalog.selected);
          }),
        ),
      ).pipe(Effect.provide(databaseLayer(stagingUrl, "canopy-projection-staging"))),
    );

    return manifest;
  });
}

function assertTrialDatabase(sql: Database, manifest: ProjectionManifest) {
  return Effect.gen(function* () {
    const trialName = "canopy_trial_" + manifest.operationId.replaceAll("-", "");
    const marker = "Canopy migration trial " + manifest.operationId;

    const [row] = yield* sql.unsafe<{ isolated: boolean; postgres_major: number }>(
      `
      SELECT current_database()=$1 AND EXISTS (SELECT FROM pg_database
          WHERE datname=current_database() AND pg_get_userbyid(datdba)=current_user
            AND shobj_description(oid,'pg_database')=$2)
        AND pg_try_advisory_xact_lock(hashtextextended('canopy.gateway_consolidation.materialize', 0))
        AND NOT (${emptyDatabaseCheck})
        AND NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())
        AND NOT EXISTS (SELECT FROM pg_prepared_xacts WHERE database=current_database()) AS isolated,
        current_setting('server_version_num')::int/10000 AS postgres_major`,
      [trialName, marker],
    );

    if (!row?.isolated)
      return yield* Effect.fail(
        consolidationError("Materialize the projection in a fresh, isolated migration trial database."),
      );

    if (row.postgres_major < manifest.database.postgresMajor)
      return yield* Effect.fail(consolidationError("The staging PostgreSQL major version is lower than the source."));
  });
}

function createProjectionTables(sql: Database, manifest: ProjectionManifest, tables: readonly SelectedTable[]) {
  return Effect.gen(function* () {
    yield* sql`CREATE TABLE public.users (id uuid PRIMARY KEY, email text NOT NULL, disabled_at timestamptz)`;
    yield* sql`CREATE TABLE public.computer_identity (owner_user_id uuid PRIMARY KEY, node_id text NOT NULL,
      name text NOT NULL, certificate text NOT NULL)`;
    yield* sql`CREATE TABLE public.schema_migrations (migration_id integer PRIMARY KEY)`;
    yield* sql`CREATE TABLE public.gateway_relocation_fence (singleton boolean PRIMARY KEY, operation_id uuid NOT NULL, state text NOT NULL)`;

    const { ownerUserId, ownerEmail, nodeId, name, certificate } = manifest.source;
    yield* sql`INSERT INTO public.users (id,email) VALUES (${ownerUserId}::uuid,${ownerEmail})`;
    yield* sql`INSERT INTO public.computer_identity VALUES (${ownerUserId}::uuid,${nodeId},${name},${certificate})`;
    yield* sql`INSERT INTO public.schema_migrations VALUES (${manifest.database.schemaMigration})`;

    if (manifest.fence)
      yield* sql`INSERT INTO public.gateway_relocation_fence VALUES (true,${manifest.operationId}::uuid,${manifest.fence})`;

    for (const [name, definition] of Object.entries(additionalTables))
      yield* sql.unsafe(`CREATE TABLE ${publicTable(name)} (${definition})`);

    for (const table of tables) {
      if (!table.types.every((type) => types.test(type)))
        return yield* Effect.fail(consolidationError("The release contains an unsupported consolidation column type."));

      const columns = table.columns.map((column, index) => `${ident(column)} ${table.types[index]}`);

      if (table.secret) columns.push(`CHECK (${ident(table.secret)} IS NULL)`);

      yield* sql.unsafe(`CREATE TABLE ${publicTable(table.name)} (${columns.join(",")})`);
      yield* sql.unsafe(
        `CREATE UNIQUE INDEX ON ${publicTable(table.name)} (${table.key.map(ident).join(",")}) NULLS NOT DISTINCT`,
      );
    }
  });
}

function loadProjectionRows(
  sql: Database,
  directory: string,
  manifest: ProjectionManifest,
  tables: readonly SelectedTable[],
) {
  return Effect.gen(function* () {
    const allowed = new Set([...tables.map(({ name }) => name), ...Object.keys(additionalTables)]);
    const rows = projectionFrames(directory, manifest);
    let table = "";
    let payloads: string[] = [];
    let bytes = 0;

    try {
      for (;;) {
        const next = yield* Effect.tryPromise({
          try: () => rows.next(),
          catch: (error) =>
            error instanceof DatabaseMigrationError
              ? error
              : consolidationError("Could not read the consolidation archive."),
        });

        if (next.done) break;

        const row = next.value;

        if (!allowed.has(row.table))
          return yield* Effect.fail(consolidationError("The archive contains a table without a consolidation policy."));

        if (payloads.length && (table !== row.table || bytes + row.bytes > 2 * 1024 * 1024)) {
          yield* insertRows(sql, table, payloads);
          payloads = [];
          bytes = 0;
        }

        table = row.table;
        bytes += row.bytes;
        payloads.push(row.payload);
      }

      if (payloads.length) yield* insertRows(sql, table, payloads);
    } finally {
      yield* Effect.tryPromise(() => rows.return(undefined));
    }
  });
}

function insertRows(sql: Database, table: string, payloads: readonly string[]) {
  const name = publicTable(table);

  // Keep numbers in their PostgreSQL representation. Bind the payload as data.
  return sql.unsafe(`INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name},$1::jsonb)`, [
    "[" + payloads.join(",") + "]",
  ]);
}
