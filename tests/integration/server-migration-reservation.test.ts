import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Code } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { migrationFenced } from "../../apps/gateway/src/api/ui-errors.ts";
import { TARGET_NOT_EMPTY } from "../../apps/gateway/src/server-migration/context.ts";
import { rawHome, refusal, startMigrationPair, type MigrationPair } from "./support/server-migration.ts";

const NOT_EMPTY = { code: Code.FailedPrecondition, message: TARGET_NOT_EMPTY };

/** A writer transaction on the server's own pool that waits inside, after its first write, until released. */
function heldWriter(env: MigrationPair, statements: { text: string; params?: unknown[] }[], isolation = "") {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const [first, ...rest] = statements;

  const done = env.server.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (isolation) yield* sql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          yield* sql.unsafe(first!.text, first!.params ?? []);
          entered();
          yield* Effect.promise(() => gate);

          for (const statement of rest) yield* sql.unsafe(statement.text, statement.params ?? []);
        }),
      );
    }),
  );

  return { inside, release, done };
}

const pending = async (call: Promise<unknown>) =>
  Promise.race([call.then(() => "settled"), Bun.sleep(400).then(() => "waiting")]);

describe.skipIf(!dockerAvailable)("server migration reservation: atomic with every writer", () => {
  let env: MigrationPair;

  beforeEach(async () => {
    env = await startMigrationPair();
  }, 60_000);

  afterEach(async () => {
    await env?.close();
  });

  const reservation = () =>
    env.serverSql<{ session_id: string | null }>("SELECT session_id FROM server_migration_reservation");

  test("a writer in flight makes the reservation wait, then refuse with its committed data", async () => {
    const writer = heldWriter(env, [
      {
        text: "INSERT INTO projects (id, owner_user_id, name, slug) VALUES (gen_random_uuid(), $1::uuid, 'Racing', 'racing')",
        params: [env.server.userId],
      },
    ]);

    await writer.inside;
    const invite = refusal(env.server.api.createServerMigrationInvitation({}));
    expect(await pending(invite)).toBe("waiting");
    writer.release();
    await writer.done;
    expect(await invite).toEqual(NOT_EMPTY);
    expect(await reservation()).toEqual([{ session_id: null }]);
    expect(await env.serverSql("SELECT 1 FROM server_migration_sessions")).toEqual([]);
  });

  test("a writer that starts during the reservation waits for it and is refused", async () => {
    // Hold the reservation's transaction open: a writer in flight on another table keeps it waiting.
    const blocker = heldWriter(env, [
      {
        text: "INSERT INTO server_migration_sessions (id, owner_user_id, role, state, protocol, build_version, schema_version) VALUES (gen_random_uuid(), $1::uuid, 'source', 'aborted', 1, '', '')",
        params: [env.server.userId],
      },
      { text: "SELECT pg_advisory_xact_lock_shared(server_migration_lock_key())" },
    ]);

    await blocker.inside;
    const invitation = await env.server.api.createServerMigrationInvitation({});
    blocker.release();
    await blocker.done;

    const writer = heldWriter(env, [
      { text: "SELECT 1" },
      {
        text: "INSERT INTO projects (id, owner_user_id, name, slug) VALUES (gen_random_uuid(), $1::uuid, 'Late', 'late')",
        params: [env.server.userId],
      },
    ]);

    await writer.inside;
    writer.release();

    const late = await writer.done.then(
      () => undefined,
      (error: Error) => error,
    );

    expect(late && migrationFenced(late)).toBe(true);
    expect((await reservation())[0]!.session_id).toBe(invitation.sessionId);
  });

  test("an older REPEATABLE READ snapshot can't write past a newer reservation", async () => {
    const writer = heldWriter(
      env,
      [
        { text: "SELECT count(*) FROM projects" },
        {
          text: "INSERT INTO projects (id, owner_user_id, name, slug) VALUES (gen_random_uuid(), $1::uuid, 'Stale', 'stale')",
          params: [env.server.userId],
        },
      ],
      "REPEATABLE READ",
    );

    await writer.inside;
    await env.server.api.createServerMigrationInvitation({});
    writer.release();

    const failed = await writer.done.then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failed).toBeDefined();
    expect(JSON.stringify(failed, Object.getOwnPropertyNames(failed))).toMatch(/40001|could not serialize|paused/);
    expect(await env.serverSql("SELECT 1 FROM projects WHERE slug='stale'")).toEqual([]);
  });

  test("after the reservation no table takes new data; the server's own start-up rows still work", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    const owner = env.server.userId;
    // The scratch project is created on first use: an exact default row passes the fence.
    await env.server.api.getOverview({});
    expect(await env.serverSql("SELECT 1 FROM projects WHERE kind='scratch'")).toHaveLength(1);
    // So are the built-in profiles and their configuration records the server writes at start.
    await env.server.core.syncProviderInstances();
    expect(await env.serverSql("SELECT 1 FROM config_items WHERE local_id='native'")).toHaveLength(3);

    const fenced = async (text: string, params: unknown[] = []) => {
      const error = await env.serverSql(text, params).then(
        () => undefined,
        (failure: Error) => failure,
      );

      return Boolean(error && migrationFenced(error));
    };

    const writes: [string, unknown[]][] = [
      ["INSERT INTO projects (id, owner_user_id, name, slug) VALUES (gen_random_uuid(), $1::uuid, 'P', 'p')", [owner]],
      ["UPDATE projects SET description='Edited' WHERE kind='scratch'", []],
      ["DELETE FROM projects WHERE kind='scratch'", []],
      ["UPDATE provider_instances SET favorites='{gpt-5.5}' WHERE harness='codex'", []],
      ["DELETE FROM provider_instances WHERE harness='grok'", []],
      [
        "INSERT INTO provider_instances (harness, id, kind, base_url) VALUES ('codex', 'proxy', 'endpoint', 'https://p.example')",
        [],
      ],
      ["UPDATE config_items SET fields=jsonb_set(fields, '{label,edited}', 'true') WHERE local_id='native'", []],
      ["INSERT INTO users (id, email, display_name) VALUES (gen_random_uuid(), 'new@localhost', 'New')", []],
      ["UPDATE users SET display_name='Renamed' WHERE id=$1::uuid", [owner]],
      ["INSERT INTO user_settings (user_id, settings, version) VALUES ($1::uuid, '{}', 1)", [owner]],
      [
        "INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by) VALUES (gen_random_uuid(), $1::uuid, 'k', '\\x00', 'env-v1', $1::uuid)",
        [owner],
      ],
    ];

    for (const [text, params] of writes) expect([text, await fenced(text, params)]).toEqual([text, true]);

    // Through the UI API too: projects and workers.
    expect((await refusal(env.server.api.createProject({ name: "Imported later" }))).code).toBe(
      Code.FailedPrecondition,
    );
    expect((await refusal(env.server.addWorker("intruder"))).code).not.toBe("resolved");
    expect((await refusal(env.server.api.createWorkerEnrollment({ name: "Intruder" }))).code).toBe(
      Code.FailedPrecondition,
    );

    // A restart re-asserts only defaults: the owner, built-in profiles and unchanged rows.
    await env.server.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("dev@localhost", "Dev")));
    await env.server.core.syncProviderInstances();
    await env.serverSql("UPDATE provider_instances SET revision=revision WHERE harness='codex'");
    expect(await env.serverSql("SELECT server_migration_occupied($1::uuid)", [owner])).toEqual([]);

    // The pairing itself is not data and continues.
    const home = await rawHome(invitation);
    await home.exchange(env.local);
    expect((await reservation())[0]!.session_id).toBe(invitation.sessionId);
  });

  test("an invitation nobody used stops reserving when it expires; then it can't pair over new data", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    await env.serverSql("UPDATE server_migration_sources SET invitation_expires_at=now() - interval '1 second'");
    await env.serverSql("UPDATE server_migration_reservation SET expires_at=now() - interval '1 second'");
    await env.server.api.createProject({ name: "Own project" });
    expect((await refusal((await rawHome(invitation)).exchange(env.local))).code).not.toBe("resolved");
    expect(await refusal(env.server.api.createServerMigrationInvitation({}))).toEqual(NOT_EMPTY);
  });

  test("a non-default bootstrap row makes the server non-empty", async () => {
    await env.server.api.getOverview({});
    await env.serverSql("UPDATE provider_instances SET favorites='{gpt-5.5}' WHERE harness='codex'");
    expect(await refusal(env.server.api.createServerMigrationInvitation({}))).toEqual(NOT_EMPTY);
    await env.serverSql("UPDATE provider_instances SET favorites='{}' WHERE harness='codex'");
    await env.serverSql("UPDATE projects SET description='Edited' WHERE kind='scratch'");
    expect(await refusal(env.server.api.createServerMigrationInvitation({}))).toEqual(NOT_EMPTY);
    await env.serverSql("UPDATE projects SET description='' WHERE kind='scratch'");
    expect((await env.server.api.createServerMigrationInvitation({})).code).toHaveLength(43);
  });
});
