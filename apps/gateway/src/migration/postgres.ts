import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectScript,
  restoreChecks,
  snapshotMetadata,
  validateSnapshot,
  type DatabaseSnapshot,
} from "./postgres-metadata.ts";
import { portableRestoreSql } from "./postgres-portable.ts";
import {
  DatabaseMigrationError,
  postgresOutput,
  psqlFlags,
  requirePostgresTool,
  spawnPostgres,
  withPostgresConnection,
  type PostgresConnection,
} from "./postgres-tools.ts";
import { emptyDatabaseCheck, validateReceipt, type RestoreReceipt } from "./postgres-target.ts";

export {
  inspectDatabaseCapacity,
  inspectTrialSample,
  preflightDatabase,
  readMigrationOwner,
  readRestoreReceipt,
  withTrialDatabase,
  type DatabaseCapacity,
  type RestoreReceipt,
} from "./postgres-target.ts";

export { DatabaseMigrationError, type DatabaseSnapshot };

const inspectError = "Could not inspect PostgreSQL. Check the admin connection and database permissions.";

const restoreError =
  "PostgreSQL restore failed or could not be confirmed. Keep the gateway stopped and check the destination before retrying.";

const downgradeError = "The destination PostgreSQL major version is lower than the source.";

export function inspectDatabase(env: NodeJS.ProcessEnv): Promise<DatabaseSnapshot> {
  return withPostgresConnection(env, async (connection) => {
    const output = await postgresOutput(
      "psql",
      [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--file=-"],
      connection.env,
      inspectError,
      inspectScript,
    );

    return snapshotMetadata(output, env);
  });
}

export function requireOfflineSource(env: NodeJS.ProcessEnv): Promise<void> {
  return withPostgresConnection(env, async (connection) => {
    const query = `SELECT NOT EXISTS (
      SELECT FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
        AND backend_type='client backend' AND pid<>pg_backend_pid()
    ) AND NOT EXISTS (SELECT FROM pg_catalog.pg_prepared_xacts WHERE database=current_database())`;

    const quiet = await postgresOutput(
      "psql",
      [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--command=" + query],
      connection.env,
      inspectError,
    );

    if (quiet !== "t")
      throw new DatabaseMigrationError(
        "Other database sessions or prepared transactions are present. Keep the source offline.",
      );
  });
}

async function postgresMajor(connection: PostgresConnection) {
  const version = await postgresOutput(
    "psql",
    [...psqlFlags, connection.argument, "--no-align", "--tuples-only", "--command=SHOW server_version_num"],
    connection.env,
    inspectError,
  );

  const major = Math.floor(Number(version) / 10000);

  if (!Number.isInteger(major) || major <= 0) throw new DatabaseMigrationError(inspectError);

  return major;
}

async function prepareDumpFile(path: string) {
  try {
    const file = await open(
      path,
      constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );

    try {
      const info = await file.stat();

      if (!info.isFile() || info.size !== 0) throw new Error();
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
  } catch {
    throw new DatabaseMigrationError("The archive destination must be a new or empty file you can write.");
  }
}

export async function dumpDatabase(env: NodeJS.ProcessEnv, destination: string): Promise<void> {
  await withPostgresConnection(env, async (connection) => {
    const dumpMajor = await requirePostgresTool("pg_dump", connection.env, await postgresMajor(connection));
    const output = resolve(destination);
    await prepareDumpFile(output);
    await postgresOutput(
      "pg_dump",
      [
        connection.argument,
        "--no-password",
        "--format=custom",
        "--no-privileges",
        "--no-tablespaces",
        ...(dumpMajor >= 18 ? ["--no-statistics"] : []),
        "--file=" + output,
      ],
      connection.env,
      "PostgreSQL dump failed. Check the admin connection, database permissions, and archive disk space.",
    );
  });
}

function restorePrelude(postgresMajor: number) {
  return String.raw`
BEGIN;
SET LOCAL synchronous_commit = on;
SET LOCAL search_path = pg_catalog;
\getenv owner_hash CANOPY_MIGRATION_OWNER
DO $canopy$
BEGIN
  IF current_setting('server_version_num')::int / 10000 < ${postgresMajor} THEN
    RAISE EXCEPTION USING ERRCODE = 'CNP01';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('canopy.gateway_migration.restore', 0))
    OR EXISTS (SELECT FROM pg_stat_activity WHERE datid =
      (SELECT oid FROM pg_database WHERE datname = current_database()) AND pid <> pg_backend_pid())
    OR EXISTS (SELECT FROM pg_prepared_xacts WHERE database = current_database()) THEN
    RAISE EXCEPTION USING ERRCODE = 'CNP02';
  END IF;
  IF ${emptyDatabaseCheck} THEN
    RAISE EXCEPTION USING ERRCODE = 'CNP03';
  END IF;
END $canopy$;
`;
}

const failures = new Map([
  ["CNP01", downgradeError],
  ["CNP02", "Other database sessions or prepared transactions are present. Keep the destination database offline."],
  ["CNP03", "The destination PostgreSQL database must be empty."],
  ["CNP04", "CANOPY_DEV_USER_EMAIL must select the gateway's existing database owner."],
  ["CNP05", "The restored schema or gateway identity does not match the archive metadata."],
  ["CNP06", "The final archive must contain the matching drained gateway fence."],
]);

async function* restoreScript(
  archive: ReturnType<typeof spawnPostgres<"ignore", "ignore">>,
  snapshot: DatabaseSnapshot,
  receipt?: RestoreReceipt,
) {
  const encoder = new TextEncoder();
  yield encoder.encode(restorePrelude(snapshot.postgresMajor));

  yield* portableRestoreSql(archive.stdout);

  // Sending COMMIT only after the archive reader exits successfully makes EOF roll back a partial restore.
  if ((await archive.exited) === 0) yield encoder.encode(restoreChecks(snapshot, receipt));
}

function archiveInput(
  archive: ReturnType<typeof spawnPostgres<"ignore", "ignore">>,
  snapshot: DatabaseSnapshot,
  receipt?: RestoreReceipt,
) {
  const script = restoreScript(archive, snapshot, receipt);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await script.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await script.return(undefined);
    },
  });
}

export async function restoreDatabase(
  env: NodeJS.ProcessEnv,
  source: string,
  snapshot: DatabaseSnapshot,
  receipt?: RestoreReceipt,
): Promise<void> {
  validateSnapshot(snapshot);
  const expected = receipt && validateReceipt(receipt);

  await withPostgresConnection(env, async (connection) => {
    if ((await postgresMajor(connection)) < snapshot.postgresMajor) throw new DatabaseMigrationError(downgradeError);

    const restoreMajor = await requirePostgresTool("pg_restore", connection.env, snapshot.postgresMajor);

    const archive = spawnPostgres(
      "pg_restore",
      [
        "--format=custom",
        "--file=-",
        "--no-owner",
        "--no-privileges",
        "--no-tablespaces",
        ...(restoreMajor >= 18 ? ["--no-statistics"] : []),
        "--exit-on-error",
        resolve(source),
      ],
      connection.env,
      "ignore",
      "ignore",
    );

    try {
      const client = spawnPostgres(
        "psql",
        [...psqlFlags, connection.argument, "--file=-"],
        connection.env,
        archiveInput(archive, snapshot, expected),
        "pipe",
      );

      const [clientCode, stderr] = await Promise.all([
        client.exited,
        new Response(client.stderr).text(),
        new Response(client.stdout).text(),
      ]);

      const failure = /(?:^|\n)psql:[^\n]*ERROR:\s+([0-9A-Z]{5})(?:\r?\n|$)/.exec(stderr)?.[1];

      if (failure) throw new DatabaseMigrationError(failures.get(failure) ?? `${restoreError} SQLSTATE ${failure}.`);

      if (clientCode !== 0 || (await archive.exited) !== 0) throw new DatabaseMigrationError(restoreError);
    } finally {
      if (archive.exitCode === null) archive.kill();
      await archive.exited;
    }
  });
}
