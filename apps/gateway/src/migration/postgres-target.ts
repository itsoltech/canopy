import { Schema } from "effect";
import { DatabaseMigrationError, postgresOutput, psqlFlags, withPostgresConnection } from "./postgres-tools.ts";

export const emptyDatabaseCheck = `
  EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'pg_toast', 'information_schema')
    AND nspname !~ '^pg_(temp|toast_temp)_[0-9]+$')
  OR EXISTS (SELECT FROM pg_depend WHERE objid >= 16384)
  OR EXISTS (SELECT FROM pg_shdepend WHERE objid >= 16384 AND dbid =
    (SELECT oid FROM pg_database WHERE datname = current_database()))
  OR EXISTS (SELECT FROM pg_largeobject_metadata)
  OR EXISTS (SELECT FROM pg_am WHERE oid >= 16384)
  OR EXISTS (SELECT FROM pg_cast WHERE oid >= 16384)
  OR EXISTS (SELECT FROM pg_default_acl)
  OR EXISTS (SELECT FROM pg_language WHERE oid >= 16384)
  OR EXISTS (SELECT FROM pg_publication)
`;

const bytes = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const uuid = Schema.String.check(Schema.isUUID());
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const decodeCapacity = Schema.decodeUnknownSync(Schema.Tuple([bytes, bytes, Schema.Boolean]));
const decodeReceipt = Schema.decodeUnknownSync(Schema.Struct({ runId: uuid, archiveSha256: sha256 }));
const decodeRunId = Schema.decodeUnknownSync(uuid);

const decodeTrialSample = Schema.decodeUnknownSync(
  Schema.Struct({ threads: bytes, workers: bytes, devices: bytes, attachments: bytes }),
);

const decodeTrialDatabase = Schema.decodeUnknownSync(
  Schema.Struct({ marker: Schema.NullOr(Schema.String), owned: Schema.Boolean }),
);

export interface DatabaseCapacity {
  postgresMajor: number;
  databaseBytes: number;
}

export interface RestoreReceipt {
  runId: string;
  archiveSha256: string;
}

async function query(env: NodeJS.ProcessEnv, sql: string, error: string): Promise<string> {
  return withPostgresConnection(env, (connection) =>
    postgresOutput(
      "psql",
      [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--command=" + sql],
      connection.env,
      error,
    ),
  );
}

async function capacity(env: NodeJS.ProcessEnv) {
  const row = await query(
    env,
    `SET search_path = pg_catalog;
     SELECT json_build_array(current_setting('server_version_num')::int / 10000,
       pg_database_size(current_database()), NOT (${emptyDatabaseCheck}));`,
    "Could not inspect the PostgreSQL version or database size.",
  );

  const [postgresMajor, databaseBytes, empty] = decodeCapacity(JSON.parse(row));

  return { postgresMajor, databaseBytes, empty };
}

export async function inspectDatabaseCapacity(env: NodeJS.ProcessEnv): Promise<DatabaseCapacity> {
  const { postgresMajor, databaseBytes } = await capacity(env);

  return { postgresMajor, databaseBytes };
}

export async function preflightDatabase(env: NodeJS.ProcessEnv, source: DatabaseCapacity): Promise<DatabaseCapacity> {
  const target = await capacity(env);

  if (target.postgresMajor < source.postgresMajor)
    throw new DatabaseMigrationError("The destination PostgreSQL major version is lower than the source.");

  if (!target.empty) throw new DatabaseMigrationError("The destination PostgreSQL database must be empty.");

  return { postgresMajor: target.postgresMajor, databaseBytes: target.databaseBytes };
}

/** Reads representative application relations from the isolated rehearsal without starting any jobs. */
export async function inspectTrialSample(env: NodeJS.ProcessEnv) {
  const result = await query(
    env,
    `SELECT json_build_object(
      'threads', (SELECT count(*) FROM public.threads),
      'workers', (SELECT count(*) FROM public.workers),
      'devices', (SELECT count(*) FROM public.mobile_devices),
      'attachments', (SELECT count(*) FROM public.attachments))`,
    "Could not inspect restored application data.",
  );

  return decodeTrialSample(JSON.parse(result));
}

export async function readMigrationOwner(env: NodeJS.ProcessEnv): Promise<string> {
  const owner = await withPostgresConnection(env, (connection) =>
    postgresOutput(
      "psql",
      [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--file=-"],
      connection.env,
      "Could not resolve the configured gateway owner.",
      String.raw`
\getenv owner_hash CANOPY_MIGRATION_OWNER
SELECT id FROM public.users WHERE disabled_at IS NULL AND
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(email, 'UTF8')), 'hex') = :'owner_hash';
`,
    ),
  );

  if (!owner) throw new DatabaseMigrationError("The configured gateway owner does not exist or is disabled.");

  return decodeRunId(owner);
}

export function validateReceipt(receipt: RestoreReceipt) {
  const result = decodeReceipt(receipt);

  return { ...result, runId: result.runId.toLowerCase() };
}

export async function readRestoreReceipt(env: NodeJS.ProcessEnv, runId: string): Promise<RestoreReceipt | undefined> {
  const id = decodeRunId(runId);

  const row = await withPostgresConnection(env, (connection) =>
    postgresOutput(
      "psql",
      [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--file=-"],
      connection.env,
      "Could not read the destination restore receipt.",
      String.raw`
SET search_path = pg_catalog;
SELECT to_regclass('public.gateway_relocation_receipts') IS NOT NULL AS has_receipts \gset
\if :has_receipts
  SELECT json_build_object('runId', run_id, 'archiveSha256', archive_sha256)
  FROM public.gateway_relocation_receipts WHERE run_id = '${id}'::uuid;
\endif
`,
    ),
  );

  return row ? decodeReceipt(JSON.parse(row)) : undefined;
}

function trialEnvironment(env: NodeJS.ProcessEnv, database: string): NodeJS.ProcessEnv {
  const url = /^(postgres(?:ql)?:\/\/[^/?]*)(?:\/[^?]*)?(?:\?(.*))?$/.exec(env["CANOPY_DATABASE_URL"] ?? "");

  if (!url?.[1]) throw new DatabaseMigrationError("Set CANOPY_DATABASE_URL to the PostgreSQL admin URL.");

  const query = (url[2] ?? "")
    .split("&")
    .filter((part) => part && decodeURIComponent(part.split("=")[0] ?? "") !== "dbname")
    .join("&");

  return { ...env, CANOPY_DATABASE_URL: url[1] + "/" + database + (query ? "?" + query : "") };
}

/** Isolates the restore in a fresh, named database on the destination. Caller serializes by run ID. */
export async function withTrialDatabase<T>(
  env: NodeJS.ProcessEnv,
  runId: string,
  use: (trialEnv: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const id = decodeRunId(runId).toLowerCase();
  const name = "canopy_trial_" + id.replaceAll("-", "");
  const trial = trialEnvironment(env, name);
  const marker = "Canopy migration trial " + id;

  const existing = await query(
    env,
    `SELECT json_build_object('marker', shobj_description(oid,'pg_database'), 'owned', pg_get_userbyid(datdba)=current_user)
     FROM pg_catalog.pg_database WHERE datname='${name}'`,
    "Could not inspect the migration trial database.",
  );

  const drop = () => query(env, `DROP DATABASE "${name}"`, "Could not remove the migration trial database.");

  if (existing) {
    const info = decodeTrialDatabase(JSON.parse(existing));
    const interruptedCreate = info.owned && info.marker === null && (await capacity(trial)).empty;

    if (!info.owned || (info.marker !== marker && !interruptedCreate))
      throw new DatabaseMigrationError("The migration trial database name is already in use.");
    await drop();
  }

  await query(
    env,
    `CREATE DATABASE "${name}" TEMPLATE template0`,
    "Could not create a migration trial database. Check CREATEDB.",
  );

  try {
    await query(env, `COMMENT ON DATABASE "${name}" IS '${marker}'`, "Could not mark the migration trial database.");

    if (
      (await query(trial, "SELECT current_database()", "Could not connect to the migration trial database.")) !== name
    )
      throw new DatabaseMigrationError("The trial database connection does not select the isolated database.");

    return await use(trial);
  } finally {
    await drop();
  }
}
