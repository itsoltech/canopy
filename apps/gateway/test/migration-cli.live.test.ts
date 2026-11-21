import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { PgClient } from "@effect/sql-pg";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { generateIdentity } from "../src/computers/identity.ts";
import { inspectDatabase, restoreDatabase } from "../src/migration/postgres.ts";
import { encryptSecret } from "../src/store/secrets.ts";

const ownerEmail = "move-gateway@example.test";
const secret = randomBytes(32);

type TestDatabase = Awaited<ReturnType<typeof openDatabase>>;

async function openDatabase(postgres: TestPostgres) {
  const runtime = ManagedRuntime.make(postgres.layer);

  try {
    const config = await runtime.runPromise(PgClient.PgClient.use((sql) => Effect.succeed(sql.config)));

    return {
      runtime,
      env: {
        CANOPY_DEV_USER_EMAIL: ownerEmail,
        CANOPY_DATABASE_URL: `postgres://postgres:test@${config.host}:${config.port}/${config.database}`,
        CANOPY_SECRETS_KEY: secret.toString("base64"),
      },
    };
  } finally {
    await runtime.dispose();
  }
}

async function withDatabase<A, E>(db: TestPostgres, effect: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) {
  const runtime = ManagedRuntime.make(db.layer);

  try {
    return await runtime.runPromise(SqlClient.SqlClient.use(effect));
  } finally {
    await runtime.dispose();
  }
}

async function command(database: TestDatabase, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, "apps/gateway/src/main.ts", "migration", ...args], {
    env: { ...process.env, ...database.env, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}

describe.skipIf(process.env["CANOPY_LIVE"] !== "1" || !dockerAvailable)("gateway database migration CLI", () => {
  const directory = tempDir("canopy-migration-cli-");
  const bundle = join(directory, "move");
  let source: TestPostgres;
  let destination: TestPostgres;
  let sourceDatabase: TestDatabase;
  let destinationDatabase: TestDatabase;
  let identity: Awaited<ReturnType<typeof generateIdentity>>;
  const owner = crypto.randomUUID();
  const worker = crypto.randomUUID();

  beforeAll(async () => {
    source = await startPostgres({ migrated: true });
    destination = await startPostgres();
    sourceDatabase = await openDatabase(source);
    destinationDatabase = await openDatabase(destination);
    identity = await generateIdentity();
    await withDatabase(source, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO public.users (id, email, display_name, role) VALUES (${owner}, ${ownerEmail}, 'Owner', 'admin')`;
        yield* sql`INSERT INTO public.computer_identity (owner_user_id, node_id, name, certificate, private_key)
          VALUES (${owner}, ${identity.nodeId}, 'Source', ${identity.certificate}, ${encryptSecret(secret, identity.privateKey)})`;
        yield* sql`INSERT INTO public.workers (id, owner_user_id, name, credential_hash, revoked_at)
          VALUES (${worker}, ${owner}, 'Former worker', 'fixture-hash', now())`;
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await destination?.stop();
    await source?.stop();
  });

  test("restores a private authenticated archive with the original owner, worker and pin", async () => {
    const finalExport = ["export", "--bundle", bundle, "--offline"];

    const busy = await withDatabase(source, (sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT 1`;

          return yield* Effect.promise(() => command(sourceDatabase, finalExport));
        }),
      ),
    );

    expect(busy).toMatchObject({ code: 1 });
    expect(busy.stderr).toContain("Keep the source offline");

    const exported = await command(sourceDatabase, finalExport);
    expect(exported).toMatchObject({ code: 0, stderr: "" });
    expect(exported.stdout).toContain(identity.fingerprint);
    expect(exported.stdout.includes(sourceDatabase.env.CANOPY_SECRETS_KEY)).toBe(false);
    expect(await command(destinationDatabase, ["verify", "--bundle", bundle])).toMatchObject({ code: 0 });

    const importArguments = ["import", "--bundle", bundle, "--offline"];

    const wrongKey = await command(destinationDatabase, importArguments, {
      CANOPY_SECRETS_KEY: randomBytes(32).toString("base64"),
    });

    expect(wrongKey).toMatchObject({ code: 1 });
    expect(wrongKey.stderr).toContain("Bundle authentication failed");

    const wrongOwner = await command(destinationDatabase, importArguments, {
      CANOPY_DEV_USER_EMAIL: "other@example.test",
    });

    expect(wrongOwner).toMatchObject({ code: 1 });
    expect(wrongOwner.stderr).toContain("CANOPY_DEV_USER_EMAIL");

    const archive = await open(join(bundle, "database.dump"), "r+");

    try {
      const firstByte = Buffer.alloc(1);
      expect((await archive.read(firstByte, 0, 1, 0)).bytesRead).toBe(1);
      await archive.write(Buffer.from([firstByte[0]! ^ 0xff]), 0, 1, 0);
      const corrupted = await command(destinationDatabase, importArguments);
      expect(corrupted).toMatchObject({ code: 1 });
      expect(corrupted.stderr).toContain("archive digest");
      await archive.write(firstByte, 0, 1, 0);
    } finally {
      await archive.close();
    }

    const snapshot = await inspectDatabase(sourceDatabase.env);

    await expect(
      restoreDatabase(destinationDatabase.env, join(bundle, "database.dump"), {
        ...snapshot,
        encryptedKeySha256: "0".repeat(64),
      }),
    ).rejects.toThrow("does not match the archive metadata");

    const tables = await withDatabase(destination, (sql) => sql`SELECT to_regclass('public.workers') AS workers`);
    expect(tables).toEqual([{ workers: null }]);
    expect(await command(destinationDatabase, importArguments)).toMatchObject({ code: 0, stderr: "" });

    const restored = await withDatabase(
      destination,
      (sql) => sql`SELECT w.id, w.owner_user_id, w.revoked_at IS NOT NULL AS revoked, i.node_id
        FROM public.workers w JOIN public.computer_identity i USING (owner_user_id)`,
    );

    expect(restored).toEqual([{ id: worker, owner_user_id: owner, revoked: true, node_id: identity.nodeId }]);

    const preview = await command(destinationDatabase, ["inspect-links"]);

    expect(preview).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(preview.stdout)).toMatchObject({ home: { workers: 1 }, peers: [], blockers: [] });
    expect(await command(destinationDatabase, importArguments)).toMatchObject({ code: 1 });
  }, 60_000);
});
