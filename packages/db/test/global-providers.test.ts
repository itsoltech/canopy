/**
 * Migration 0018 (docs/worker-config.md, section 9): per-worker provider profiles become global instances with the
 * same ids, so threads keep resolving; differences on a later worker become its overrides, a profile id that
 * connects differently there gets its own instance and its threads move to it; model choices and favorite models
 * move to the instances.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

const id = () => Bun.randomUUIDv7();
let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

function query<A extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<ReadonlyArray<A>> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params);
    }),
  );
}

const before = Migrator.make({})({ loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 18)), table: "schema_migrations" });

const user = id();
const [w1, w2] = [id(), id()].sort() as [string, string];
const project = id();
const threads = { proxyOnW1: id(), proxyOnW2: id(), nativeOnW2: id() };

describe.skipIf(!dockerAvailable)("migration 0018: per-worker profiles to global instances", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(before);
    await query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, 'u@x', 'U', 'user')`, [user]);
    await query(`INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES ($1, $3, 'w1', 'h'), ($2, $3, 'w2', 'h')`, [w1, w2, user]);
    await query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1::uuid, $2, 'P', $1::text)`, [project, user]);
    const [ws1, ws2] = [id(), id()];
    await query(`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES ($1, $3, $4, '/repo'), ($2, $3, $5, '/repo')`, [ws1, ws2, project, w1, w2]);
    const workspaceOf = (worker: string) => (worker === w1 ? ws1 : ws2);
    const secret = async (name: string) => {
      const sid = id();
      await query(`INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by) VALUES ($1, $2, $3, '\\x00', 'k', $2)`, [sid, user, name]);
      return sid;
    };
    const [k1, k2] = [await secret("cliproxyapi-1"), await secret("profile-2")];
    const config = (profiles: unknown[]) => JSON.stringify({ version: "3", allowedRoots: ["/repo"], profiles });
    // w1: the live stack's shape (proxy for both harnesses, implicit native) plus a Codex-only native-kind "work".
    await query(`INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES ($1, 3, $2::jsonb, $3)`, [
      w1,
      config([
        { id: "cliproxyapi", kind: "PROVIDER_PROFILE_KIND_CLIPROXYAPI", baseUrl: "http://proxy-a:8317", apiKey: { secretRef: k1 } },
        { id: "work", kind: "PROVIDER_PROFILE_KIND_NATIVE", providers: ["PROVIDER_CODEX"], displayName: "Work", env: [{ name: "A", value: "1" }] },
      ]),
      user,
    ]);
    // w2: the same proxy at another address and key, native with a variable, and "work" as an endpoint (conflict).
    await query(`INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES ($1, 3, $2::jsonb, $3)`, [
      w2,
      config([
        { id: "native", kind: "PROVIDER_PROFILE_KIND_NATIVE", displayName: "Device", env: [{ name: "B", value: "2" }] },
        { id: "cliproxyapi", kind: "PROVIDER_PROFILE_KIND_CLIPROXYAPI", baseUrl: "http://proxy-b:8317", apiKey: { secretRef: k2 }, disabled: true },
        { id: "work", kind: "PROVIDER_PROFILE_KIND_CLIPROXYAPI", providers: ["PROVIDER_CODEX"], baseUrl: "http://w:1", apiKey: { secretRef: k2 } },
      ]),
      user,
    ]);
    const thread = (tid: string, worker: string, provider: string, profile: string | null) =>
      query(
        `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, provider_profile_id, worker_id, workspace_id, cwd, status)
         VALUES ($1, $2, $3, 'main', $1, 'worker', $4, $5, $6, $7, '/repo', 'idle')`,
        [tid, project, user, provider, profile, worker, workspaceOf(worker)],
      );
    await thread(threads.proxyOnW1, w1, "codex", "cliproxyapi");
    await thread(threads.proxyOnW2, w2, "codex", "work");
    await thread(threads.nativeOnW2, w2, "claude", null);
    await query(
      `INSERT INTO provider_model_selections (worker_id, profile_id, provider, shown, known, show_new, updated_by) VALUES ($1, 'cliproxyapi', 'codex', '{a}', '{a,b,c}', true, $2)`,
      [w1, user],
    );
    await query(`INSERT INTO user_settings (user_id, settings, version) VALUES ($1, $2::jsonb, 1)`, [
      user,
      JSON.stringify({ modelFavorites: { models: [{ provider: "PROVIDER_CODEX", profileId: "cliproxyapi", model: "a" }, { provider: "PROVIDER_CLAUDE", model: "opus" }] } }),
    ]);
    expect((await runtime.runPromise(migrate)).map(([n, name]) => `${n}_${name}`)).toEqual(["18_global_providers"]);
  }, 90_000);

  afterAll(async () => {
    await runtime?.dispose();
    pg?.stop();
  });

  test("instances per harness keep the profile ids; the first worker defines them", async () => {
    const rows = await query<{ harness: string; id: string; kind: string; label: string; base_url: string; built_in: boolean; all_workers: boolean }>(
      `SELECT harness, id, kind, label, base_url, built_in, all_workers FROM provider_instances ORDER BY harness, id`,
    );
    expect(rows.map((r) => `${r.harness}/${r.id}:${r.kind}:${r.base_url}`)).toEqual([
      "claude/cliproxyapi:endpoint:http://proxy-a:8317",
      "claude/native:native:",
      "codex/cliproxyapi:endpoint:http://proxy-a:8317",
      "codex/native:native:",
      "codex/work:native:",
      "codex/work-2:endpoint:http://w:1",
    ]);
    expect(rows.filter((r) => r.built_in).map((r) => [r.id, r.all_workers, r.label])).toEqual([
      ["native", true, "Device"],
      ["native", true, "Device"],
    ]);
  });

  test("workers: enabled as before, differences as overrides", async () => {
    const rows = await query<{ harness: string; instance_id: string; worker_id: string; enabled: boolean | null; overrides: Record<string, unknown> }>(
      `SELECT harness, instance_id, worker_id, enabled, overrides FROM provider_instance_workers ORDER BY harness, instance_id, worker_id`,
    );
    const of = (h: string, i: string, w: string) => rows.find((r) => r.harness === h && r.instance_id === i && r.worker_id === w);
    expect(of("codex", "cliproxyapi", w1)).toMatchObject({ enabled: true, overrides: {} });
    const overridden = of("codex", "cliproxyapi", w2)!;
    expect(overridden.enabled).toBe(false);
    expect(overridden.overrides).toMatchObject({ baseUrl: "http://proxy-b:8317", apiKey: { secretRef: expect.any(String) } });
    expect(of("claude", "native", w2)?.overrides).toEqual({ env: [{ name: "B", value: "2" }] });
    expect(of("codex", "work", w2)).toBeUndefined();
    expect(of("codex", "work-2", w2)).toMatchObject({ enabled: true });
  });

  test("threads keep resolving (a conflicting id moves to its own instance)", async () => {
    const rows = await query<{ id: string; provider_profile_id: string | null }>(`SELECT id, provider_profile_id FROM threads`);
    const profile = new Map(rows.map((r) => [r.id, r.provider_profile_id]));
    expect(profile.get(threads.proxyOnW1)).toBe("cliproxyapi");
    expect(profile.get(threads.proxyOnW2)).toBe("work-2");
    expect(profile.get(threads.nativeOnW2)).toBeNull();
  });

  test("model choices and favorites move to the instances", async () => {
    const rows = await query<{ harness: string; id: string; hidden_models: string[]; shown_models: string[]; favorites: string[] }>(
      `SELECT harness, id, hidden_models, shown_models, favorites FROM provider_instances ORDER BY harness, id`,
    );
    const codexProxy = rows.find((r) => r.harness === "codex" && r.id === "cliproxyapi")!;
    expect(codexProxy).toMatchObject({ hidden_models: ["b", "c"], shown_models: ["a"], favorites: ["a"] });
    expect(rows.filter((r) => r.harness === "claude").map((r) => r.favorites)).toEqual([["opus"], ["opus"]]);
    expect(await query(`SELECT 1 FROM pg_tables WHERE tablename = 'provider_model_selections'`)).toHaveLength(0);
  });
});
