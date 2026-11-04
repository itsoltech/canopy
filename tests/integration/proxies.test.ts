import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { ConfigAppliedSchema, Provider, ProviderProfileKind, ui, type WorkerConfig } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, InstanceStore, encryptSecret } from "@canopy/gateway/store";
import { applyWorkerConfig } from "@canopy/worker/config";
import { claudeProfileOptions } from "../../apps/worker/src/providers/claude/profile.ts";
import { codexAppServerLaunch } from "../../apps/worker/src/providers/codex/launch.ts";
import { prepareCodexHome } from "../../apps/worker/src/providers/codex/home.ts";
import { grokLaunch } from "../../apps/worker/src/providers/grok/launch.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const SECRET = "fixture-proxy-secret";
const REPLACED = "fixture-replaced-secret";
const scratch = tempDir("canopy-proxies-");
let gw: TestGateway;
let proxy: ui.Proxy;

const query = <A extends object>(statement: string, params: readonly (string | Uint8Array)[] = []) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(statement, params);
    }),
  );

async function latest(): Promise<WorkerConfig> {
  return eventually(
    async () => gw.worker.configs.at(-1)!,
    (config) => config.profiles.filter((p) => p.id === "reusable").length === 3,
  );
}

describe.skipIf(!dockerAvailable)("reusable proxies across the gateway and worker link", () => {
  beforeAll(async () => {
    gw = await startTestGateway({ worker: { claude: true } });
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          gw.workerId,
          { allowedRoots: ["/repo"], claude: { enabled: true }, codex: { enabled: true }, grok: { enabled: true } },
          gw.userId,
        ),
      ),
    );
    await gw.core.syncProviderInstances();
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("one encrypted proxy resolves to Claude, Codex and Grok mappings without credentials in UI, reports, files or argv", async () => {
    proxy = (
      await gw.api.saveProxy({
        name: "Shared proxy",
        kind: "cliproxyapi",
        baseUrl: "https://proxy.example/v1/",
        secret: SECRET,
        codex: { wireApi: "responses", supportsWebsockets: true, extraHeaders: { "X-Route": "agents" } },
      })
    ).proxy!;
    expect(proxy.baseUrl).toBe("https://proxy.example");
    expect(proxy.secretSet).toBe(true);

    for (const harness of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      const saved = (
        await gw.api.saveProviderInstance({
          harness,
          id: "reusable",
          create: true,
          label: "Reusable",
          kind: ProviderProfileKind.CLIPROXYAPI,
          proxyId: proxy.id,
          allWorkers: true,
        })
      ).instance!;

      expect(saved.proxyId).toBe(proxy.id);
    }

    const wire = await latest();

    const applied = applyWorkerConfig(wire, {
      which: (name) => `/fixture/${name}`,
      version: () => "1.0.70",
      realDirectory: (p) => p,
    });

    if (!applied.applied) throw new Error("worker rejected proxy configuration");
    const profiles = applied.config.profiles.filter((p) => p.config.id === "reusable");
    const claude = profiles.find((p) => p.resolved?.providers.includes("claude"))!.resolved!;
    const codex = profiles.find((p) => p.resolved?.providers.includes("codex"))!.resolved!;
    const grok = profiles.find((p) => p.resolved?.providers.includes("grok"))!.resolved!;
    expect(claudeProfileOptions(claude, {}).env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_API_KEY: "",
    });
    const home = prepareCodexHome({ dataDir: scratch, linkDeviceLogin: false });
    const launch = codexAppServerLaunch([codex], {}, "codex", undefined, home.path);
    expect(launch.env["CODEX_HOME"]).toBe(join(scratch, "codex-home"));
    expect(existsSync(join(home.path, "auth.json"))).toBe(false);
    expect(launch.env["CANOPY_REUSABLE_API_KEY"]).toBe(SECRET);
    expect(launch.command).toContain('model_providers.canopy_reusable.base_url="https://proxy.example/v1"');
    expect(launch.command).toContain('model_providers.canopy_reusable.wire_api="responses"');
    expect(launch.command).toContain("model_providers.canopy_reusable.supports_websockets=true");
    expect(launch.command).toContain('model_providers.canopy_reusable.http_headers."X-Route"="agents"');
    expect(launch.command.join(" ").includes(SECRET)).toBe(false);

    const grokProcess = grokLaunch({
      dataDir: scratch,
      profile: grok,
      model: "fixture-model",
      baseEnv: {},
      linkDeviceLogin: false,
    });

    try {
      expect(grokProcess.options.env?.["CANOPY_GROK_API_KEY"]).toBe(SECRET);
      const config = readFileSync(join(grokProcess.options.env!["GROK_HOME"]!, "config.toml"), "utf8");
      expect(config).toContain('base_url = "https://proxy.example/v1"');
      expect(config).toContain('api_backend = "chat_completions"');
      expect(config.includes(SECRET)).toBe(false);
    } finally {
      grokProcess.cleanup();
    }

    const publicData = JSON.stringify([
      toJson(ui.ListProxiesResponseSchema, await gw.api.listProxies({})),
      toJson(ui.ListProviderInstancesResponseSchema, await gw.api.listProviderInstances({})),
      toJson(ConfigAppliedSchema, create(ConfigAppliedSchema, applied.report)),
    ]);

    expect(publicData.includes(SECRET)).toBe(false);

    const stored = await query<{ ciphertext: Uint8Array }>(
      "SELECT s.ciphertext FROM proxies p JOIN secrets s ON s.id=p.secret_id WHERE p.id=$1",
      [proxy.id],
    );

    expect(Buffer.from(stored[0]!.ciphertext).toString().includes(SECRET)).toBe(false);
  });

  test("replacement updates all users of the proxy; stale edits, incompatible kinds and deletion are blocked with profile references", async () => {
    const updated = (
      await gw.api.saveProxy({
        id: proxy.id,
        expectedRevision: proxy.revision,
        name: proxy.name,
        kind: proxy.kind,
        baseUrl: proxy.baseUrl,
        secret: REPLACED,
        codex: proxy.codex,
      })
    ).proxy!;

    await eventually(
      async () => gw.worker.configs.at(-1)!,
      (config) => config.profiles.filter((p) => p.id === "reusable").every((p) => p.apiKey === REPLACED),
    );
    expect(updated.usedBy).toEqual(["claude/reusable", "codex/reusable", "grok/reusable"]);
    expect(await failure(gw.api.deleteProxy({ id: proxy.id }))).toContain("codex/reusable");
    expect(
      await failure(
        gw.api.saveProxy({
          id: proxy.id,
          expectedRevision: proxy.revision,
          name: proxy.name,
          kind: proxy.kind,
          baseUrl: proxy.baseUrl,
        }),
      ),
    ).toContain("changed meanwhile");
    expect(
      await failure(gw.api.saveProxy({ id: proxy.id, name: proxy.name, kind: "anthropic", baseUrl: proxy.baseUrl })),
    ).toContain("does not support");

    const audit = await query<{ action: string; details: object }>(
      "SELECT action, details FROM audit_log WHERE target_id=$1 ORDER BY created_at",
      [proxy.id],
    );

    expect(audit.map((a) => a.action)).toEqual(["proxy.created", "proxy.updated", "proxy.secret_replaced"]);
    expect(audit.every((a) => JSON.stringify(a.details) === "{}")).toBe(true);
    proxy = updated;
  });

  test("foreign owners cannot list, edit, delete, test or attach a proxy, and their worker never receives it", async () => {
    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@example.test", "Other")));
    const use = gw.runtime.runPromise.bind(gw.runtime);
    expect(await use(InstanceStore.use((s) => s.listProxies(other)))).toEqual([]);
    expect(await use(InstanceStore.use((s) => s.list(other)))).toSatisfy((instances: ui.ProviderInstance[]) =>
      instances.every((i) => !i.proxyId),
    );

    for (const operation of [
      InstanceStore.use((s) => s.testProxy(other, create(ui.ProxyIdRequestSchema, { id: proxy.id }))),
      InstanceStore.use((s) => s.deleteProxy(other, create(ui.ProxyIdRequestSchema, { id: proxy.id }))),
      InstanceStore.use((s) =>
        s.moveInstanceToProxy(
          other,
          create(ui.MoveInstanceToProxyRequestSchema, { harness: Provider.CLAUDE, id: "reusable" }),
        ),
      ),
      InstanceStore.use((s) =>
        s.saveProxy(
          other,
          create(ui.SaveProxyRequestSchema, {
            id: proxy.id,
            name: "Foreign",
            kind: "cliproxyapi",
            baseUrl: proxy.baseUrl,
          }),
        ),
      ),
      InstanceStore.use((s) =>
        s.save({
          userId: other,
          request: create(ui.SaveProviderInstanceRequestSchema, {
            harness: Provider.CODEX,
            id: "foreign",
            create: true,
            label: "Foreign",
            kind: ProviderProfileKind.CLIPROXYAPI,
            proxyId: proxy.id,
          }),
        }),
      ),
    ])
      expect(await failure(use(operation))).toContain("proxy not found");
    const worker = await gw.addWorker("Other owner", ["/repo"]);
    await query("UPDATE workers SET owner_user_id=$1 WHERE id=$2", [other, worker.workerId]);
    await gw.runtime.runPromise(InstanceStore.use((s) => s.sync(other, [worker.workerId])));
    const connected = await gw.connect(worker.workerId, worker.credential);
    await eventually(async () => connected.configs.at(-1), Boolean);
    expect(connected.configs.at(-1)!.profiles.some((p) => p.id === "reusable")).toBe(false);
  });

  test("startup migration deduplicates independently encrypted endpoint keys and preserves profile IDs and worker overrides", async () => {
    const anthropic = (
      await gw.api.saveProxy({
        name: "Claude-only preset",
        kind: "anthropic",
        baseUrl: "https://legacy.example",
        secret: "fixture-migrated-key",
      })
    ).proxy!;

    for (const [harness, suffix] of [
      ["claude", ""],
      ["codex", "/v1/"],
    ] as const) {
      const secretId = Bun.randomUUIDv7();
      await query(
        "INSERT INTO secrets(id,owner_user_id,name,ciphertext,key_id,created_by) VALUES($1,$2,$3,$4,'env-v1',$2)",
        [secretId, gw.userId, `instance-${secretId}`, encryptSecret(gw.secretsKey, "fixture-migrated-key")],
      );
      await query(
        "INSERT INTO provider_instances(harness,id,label,kind,base_url,api_key,created_by,all_workers) VALUES($1,'legacy','Legacy','endpoint',$2,jsonb_build_object('secretRef',$3::text),$4,true)",
        [harness, `https://legacy.example${suffix}`, secretId, gw.userId],
      );
    }

    await query(
      "INSERT INTO provider_instance_workers(harness,instance_id,worker_id,enabled,overrides) VALUES('codex','legacy',$1,true,jsonb_build_object('baseUrl','https://override.example/v1','binaryPath','/fixture/codex'))",
      [gw.workerId],
    );

    await gw.core.syncProviderInstances();
    const migrated = (await gw.api.listProviderInstances({})).instances.filter((i) => i.id === "legacy");
    expect(migrated).toHaveLength(2);
    expect(new Set(migrated.map((i) => i.proxyId)).size).toBe(1);
    expect(migrated[0]!.proxyId).not.toBe(anthropic.id);
    expect(migrated.every((i) => i.baseUrl === "https://legacy.example")).toBe(true);

    const assignment = migrated
      .find((i) => i.harness === Provider.CODEX)!
      .workers.find((w) => w.workerId === gw.workerId)!;

    expect(assignment.overrides?.proxyId).not.toBe("");
    expect(assignment.overrides?.binaryPath).toBe("/fixture/codex");
    const count = (await gw.api.listProxies({})).proxies.length;
    await gw.core.syncProviderInstances();
    expect((await gw.api.listProxies({})).proxies.length).toBe(count);

    await gw.api.setInstanceWorker({
      harness: Provider.CODEX,
      id: "legacy",
      workerId: gw.workerId,
      overrides: { baseUrl: "https://override-next.example/v1" },
    });
    await eventually(
      async () => gw.worker.configs.at(-1)!,
      (config) =>
        config.profiles.some(
          (p) =>
            p.id === "legacy" &&
            p.providers.includes(Provider.CODEX) &&
            p.baseUrl === "https://override-next.example" &&
            p.apiKey === "fixture-migrated-key",
        ),
    );
    await gw.api.setInstanceWorker({
      harness: Provider.CODEX,
      id: "legacy",
      workerId: gw.workerId,
      overrides: { proxyId: proxy.id },
    });
    await eventually(
      async () => gw.worker.configs.at(-1)!,
      (config) =>
        config.profiles.some((p) => p.id === "legacy" && p.providers.includes(Provider.CODEX) && p.apiKey === REPLACED),
    );
    await gw.api.setInstanceWorker({
      harness: Provider.CODEX,
      id: "legacy",
      workerId: gw.workerId,
      overrides: { proxyId: "" },
    });
    await eventually(
      async () => gw.worker.configs.at(-1)!,
      (config) =>
        config.profiles.some(
          (p) => p.id === "legacy" && p.providers.includes(Provider.CODEX) && p.baseUrl === "https://legacy.example",
        ),
    );
  });

  test("Codex environment migration rolls back on an invalid destination and then moves its key without disclosure", async () => {
    const native = (
      await gw.api.saveProviderInstance({
        harness: Provider.CODEX,
        id: "native",
        kind: ProviderProfileKind.NATIVE,
        env: [
          { name: "OPENAI_BASE_URL", value: "https://codex-manual.example/v1" },
          { name: "OPENAI_API_KEY", value: "fixture-codex-manual", secret: true },
        ],
      })
    ).instance!;

    const before = (await gw.api.listProxies({})).proxies.length;
    expect(
      await failure(
        gw.api.moveInstanceToProxy({
          harness: Provider.CODEX,
          id: "native",
          newInstanceId: "native",
          name: "Invalid destination",
        }),
      ),
    ).toContain("built-in");
    expect((await gw.api.listProxies({})).proxies.length).toBe(before);

    const unchanged = (await gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CODEX && i.id === "native",
    )!;

    expect(unchanged.env).toHaveLength(2);
    expect(unchanged.revision).toBe(native.revision);

    const moved = (
      await gw.api.moveInstanceToProxy({
        harness: Provider.CODEX,
        id: "native",
        newInstanceId: "codex-moved",
        name: "Codex migrated",
        expectedRevision: native.revision,
      })
    ).instance!;

    expect(moved.proxyId).not.toBe("");
    expect(JSON.stringify(toJson(ui.ProviderInstanceSchema, moved)).includes("fixture-codex-manual")).toBe(false);

    const original = (await gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CODEX && i.id === "native",
    )!;

    expect(original.env).toHaveLength(0);
  });

  test("manual native environment credentials move server-side into a new instance, leaving device login and unrelated variables intact", async () => {
    const native = (
      await gw.api.saveProviderInstance({
        harness: Provider.CLAUDE,
        id: "native",
        kind: ProviderProfileKind.NATIVE,
        env: [
          { name: "ANTHROPIC_BASE_URL", value: "https://manual.example/v1" },
          { name: "ANTHROPIC_AUTH_TOKEN", value: "fixture-manual-key", secret: false },
          { name: "KEEP_ME", value: "kept" },
        ],
      })
    ).instance!;

    expect(native.env.find((v) => v.name === "ANTHROPIC_AUTH_TOKEN")).toMatchObject({ secret: true, value: "" });

    const moved = (
      await gw.api.moveInstanceToProxy({
        harness: Provider.CLAUDE,
        id: "native",
        expectedRevision: native.revision,
        newInstanceId: "moved-proxy",
        name: "Moved proxy",
      })
    ).instance!;

    expect(moved.proxyId).not.toBe("");

    const original = (await gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CLAUDE && i.id === "native",
    )!;

    expect(original.kind).toBe(ProviderProfileKind.NATIVE);
    expect(original.env.map((v) => v.name)).toEqual(["KEEP_ME"]);
    expect((await gw.api.listProxies({})).proxies.find((p) => p.id === moved.proxyId)?.secretSet).toBe(true);
  });

  test("unexpected database failures never expose credential-bearing causes in UI errors or logs", async () => {
    await query(
      "CREATE FUNCTION fixture_proxy_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-sensitive-database-cause'; END $$",
    );
    await query(
      "CREATE TRIGGER fixture_proxy_failure BEFORE INSERT ON proxies FOR EACH ROW EXECUTE FUNCTION fixture_proxy_failure()",
    );
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      const error = await failure(
        gw.api.saveProxy({ name: "Failure", kind: "cliproxyapi", baseUrl: "https://failure.example", secret: SECRET }),
      );

      expect(error).toContain("Provider operation failed");
      expect(error).not.toContain(SECRET);
      expect(error).not.toContain("fixture-sensitive-database-cause");
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await query("DROP TRIGGER fixture_proxy_failure ON proxies");
      await query("DROP FUNCTION fixture_proxy_failure()");
    }
  });

  test("connection probe detects CLIProxyAPI, counts models and sanitizes reflected error bodies; unused proxies can be deleted", async () => {
    let failed = false;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/") return Response.json({ message: "CLI Proxy API Server" });

        if (request.headers.get("authorization") !== `Bearer ${SECRET}`)
          return new Response("Unauthorized", { status: 401 });

        return failed ? new Response(SECRET, { status: 403 }) : Response.json({ data: [{ id: "one" }, { id: "two" }] });
      },
    });

    try {
      const tested = (
        await gw.api.saveProxy({ name: "Probe", kind: "cliproxyapi", baseUrl: server.url.toString(), secret: SECRET })
      ).proxy!;

      const result = await gw.api.testProxy({ id: tested.id });
      expect(result).toMatchObject({ ok: true, modelCount: 2, cliproxyapiDetected: true });
      failed = true;
      const error = await gw.api.testProxy({ id: tested.id });
      expect(error.ok).toBe(false);
      expect(error.detail).toContain("403");
      expect(error.detail.includes(SECRET)).toBe(false);
      await gw.api.deleteProxy({ id: tested.id, expectedRevision: tested.revision });
      expect((await gw.api.listProxies({})).proxies.some((p) => p.id === tested.id)).toBe(false);
      expect(
        (
          await query<{ action: string }>("SELECT action FROM audit_log WHERE target_id=$1 ORDER BY created_at", [
            tested.id,
          ])
        ).map((r) => r.action),
      ).toEqual(["proxy.created", "proxy.deleted"]);
    } finally {
      await server.stop(true);
    }
  });
});
