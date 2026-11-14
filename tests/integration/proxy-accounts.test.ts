import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, InstanceStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { ProxyAccountsMonitor } from "../../apps/gateway/src/core/proxy-accounts.ts";

const KEY = "fixture-management-key";
const WRONG = "fixture-wrong-management-key";
const SECRET = "fixture-inference-secret";

/** What a CLIProxyAPI v8 `GET /v0/management/auth-files` returns, including hostile text. */
const FILES = [
  {
    id: "codex-a.json",
    auth_index: "1",
    name: "codex-a.json",
    provider: "codex",
    email: "a@example.test",
    status: "active",
    disabled: false,
    unavailable: false,
    success: 12,
    failed: 1,
    quota: {
      observed_at: "2026-11-14T10:00:00Z",
      signals: {
        "X-Codex-Primary-Used-Percent": "42",
        "X-Codex-Primary-Window-Minutes": "300",
        "X-Codex-Primary-Reset-At": "2000000000",
        "X-Codex-Secondary-Used-Percent": "7",
        "X-Codex-Secondary-Window-Minutes": "10080",
      },
    },
  },
  {
    id: "codex-b.json",
    auth_index: "2",
    provider: "codex",
    label: "Team",
    status: "error",
    unavailable: true,
    next_retry_after: "2099-01-01T00:00:00Z",
    status_message: "quota exhausted",
  },
  {
    id: "claude.json",
    auth_index: "3",
    provider: "claude",
    email: "c@example.test",
    status: "error",
    requires_sign_in: true,
    unavailable: true,
    refresh_error: { message: "<img src=x onerror=alert(1)> refresh failed: Bearer abc.def token=xyz\n\u0007" },
  },
  {
    id: "gemini.json",
    auth_index: "4",
    provider: "gemini",
    email: "g@example.test",
    status: "disabled",
    disabled: true,
  },
  { id: "odd.json", provider: 7, email: ["not text"] },
];

let mode: "ok" | "remote" | "huge" | "html" | "echo" | "endless403" = "ok";

const base64 = (value: string) => Buffer.from(value).toString("base64");

/** A proxy that echoes the secrets it knows in every text field, raw and encoded. */
const ECHO = [
  {
    id: KEY,
    auth_index: encodeURIComponent(KEY),
    provider: KEY,
    email: `${KEY}@example.test`,
    label: base64(SECRET),
    status: "error",
    status_message: `key ${KEY} secret ${SECRET} url ${encodeURIComponent(SECRET)} b64 ${base64(KEY).replace(/=+$/, "")}`,
    refresh_error: { message: `${Buffer.from(KEY).toString("base64url")} failed` },
  },
];

/** A 403 whose body never ends: only a prefix may be read. */
const endless = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("remote management disabled "));
    },
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024).fill(32));
    },
  });

let requests: string[] = [];

const management = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/v0/management/auth-files") return new Response("not found", { status: 404 });
    const auth = request.headers.get("authorization") ?? "";
    requests.push(auth === `Bearer ${KEY}` ? "key" : auth === `Bearer ${WRONG}` ? "wrong" : "other");

    if (mode === "remote") return Response.json({ error: "remote management disabled" }, { status: 403 });

    if (mode === "endless403") return new Response(endless(), { status: 403 });

    if (auth !== `Bearer ${KEY}`) return Response.json({ error: "invalid management key" }, { status: 401 });

    if (mode === "huge") return Response.json({ files: [{ id: "x".repeat(5 * 1024 * 1024) }] });

    if (mode === "html") return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });

    if (mode === "echo") return Response.json({ files: ECHO });

    return Response.json({ observed_at: new Date().toISOString(), files: FILES });
  },
});

const root = `http://127.0.0.1:${management.port}`;
let gw: TestGateway;

const query = <A extends object>(statement: string, params: readonly string[] = []) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(statement, params);
    }),
  );

const save = async (id: string, managementKey?: string, baseUrl = root) =>
  (
    await gw.api.saveProxy({
      id,
      name: "Accounts proxy",
      kind: "cliproxyapi",
      baseUrl,
      ...(!id && { secret: SECRET }),
      ...(managementKey !== undefined && { managementKey }),
    })
  ).proxy!;

const refresh = (id: string, force = true) => gw.api.refreshProxyAccounts({ id, force });

describe.skipIf(!dockerAvailable)("CLIProxyAPI upstream accounts through the management API", () => {
  let proxy: ui.Proxy;

  beforeAll(async () => {
    gw = await startTestGateway();
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    await management.stop(true);
  });

  test("an encrypted management key reads typed, sanitized accounts and pushes only that proxy's change", async () => {
    proxy = await save("", KEY);
    expect(proxy.managementKeySet).toBe(true);

    const updates: ui.OverviewUpdate[] = [];
    const abort = new AbortController();

    const watching = (async () => {
      for await (const update of gw.api.watchOverview({}, { signal: abort.signal })) updates.push(update);
    })().catch(() => {});

    try {
      requests = [];
      const accounts = await refresh(proxy.id);

      expect(requests).toEqual(["key"]);
      expect(accounts).toMatchObject({ proxyId: proxy.id, state: "ok", total: 5 });
      const byId = new Map(accounts.accounts.map((a) => [a.id, a]));
      expect(accounts.accounts).toHaveLength(4);
      expect(byId.get("1")).toMatchObject({ provider: "codex", label: "a@example.test", status: "active" });
      expect(byId.get("1")?.successCount).toBe(12n);
      expect(byId.get("1")?.windows.map((w) => [w.key, w.usedPercent, w.resetsAt?.seconds])).toEqual([
        ["five_hour", 42, 2000000000n],
        ["seven_day", 7, undefined],
      ]);
      expect(byId.get("2")).toMatchObject({ label: "Team", status: "cooling_down", detail: "quota exhausted" });
      expect(byId.get("2")?.retryAt?.seconds).toBe(BigInt(Date.parse("2099-01-01T00:00:00Z") / 1000));
      expect(byId.get("3")?.status).toBe("sign_in");
      expect(byId.get("3")?.detail).not.toMatch(/[<>\n]|abc\.def|xyz/);
      expect(byId.get("3")?.detail).not.toContain(String.fromCharCode(7));
      expect(byId.get("3")?.detail).toStartWith("refresh failed: Bearer [redacted]");
      expect(byId.get("4")).toMatchObject({ provider: "gemini", status: "disabled" });

      await eventually(
        async () => updates.find((u) => u.change.case === "proxyAccounts"),
        (u) => u !== undefined,
      );
      expect((await gw.api.listProxies({})).proxies.find((p) => p.id === proxy.id)?.accounts?.state).toBe("ok");

      // A view that opens again within a minute reuses the read; an unchanged forced read pushes nothing.
      await refresh(proxy.id, false);
      expect(requests).toHaveLength(1);
      const pushed = updates.filter((u) => u.change.case === "proxyAccounts").length;
      await Bun.sleep(5_100);
      await refresh(proxy.id);
      expect(requests).toHaveLength(2);
      expect(updates.filter((u) => u.change.case === "proxyAccounts")).toHaveLength(pushed);
    } finally {
      abort.abort();
      await watching;
    }
  }, 30_000);

  test("the key stays in the gateway: encrypted at rest, absent from every response and audited without values", async () => {
    const responses = [
      toJsonString(ui.ListProxiesResponseSchema, await gw.api.listProxies({})),
      toJsonString(ui.ProxyAccountsSchema, await refresh(proxy.id, false)),
      toJsonString(ui.GetOverviewResponseSchema, await gw.api.getOverview({})),
    ];

    for (const text of responses) expect(text).not.toContain(KEY);

    const stored = await query<{ ciphertext: Uint8Array }>(
      "SELECT s.ciphertext FROM proxies p JOIN secrets s ON s.id = p.management_secret_id WHERE p.id = $1::uuid",
      [proxy.id],
    );

    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]!.ciphertext).toString("utf8")).not.toContain(KEY);

    const audit = await query<{ action: string; details: object }>(
      "SELECT action, details FROM audit_log WHERE target_id = $1::uuid ORDER BY created_at",
      [proxy.id],
    );

    expect(audit.map((a) => a.action)).toContain("proxy.management_key_replaced");
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  test("a wrong key is read once and never retried on its own; Refresh tries again", async () => {
    proxy = await save(proxy.id, WRONG);
    requests = [];
    await eventually(
      async () => (await gw.api.listProxies({})).proxies.find((p) => p.id === proxy.id)?.accounts?.state,
      (state) => state === "unauthorized",
    );
    expect(requests).toEqual(["wrong"]);
    // A view that opens and the periodic check take the same path: the rejection is not sent again.
    expect((await refresh(proxy.id, false)).state).toBe("unauthorized");
    expect(requests).toEqual(["wrong"]);
    await Bun.sleep(5_100);
    expect((await refresh(proxy.id)).state).toBe("unauthorized");
    expect(requests).toEqual(["wrong", "wrong"]);
  }, 30_000);

  test("disabled remote management, oversized or non-JSON bodies, an unreachable host and no key degrade to states", async () => {
    proxy = await save(proxy.id, KEY);
    mode = "remote";
    await Bun.sleep(5_100);
    expect((await refresh(proxy.id)).state).toBe("remote_disabled");
    mode = "huge";
    await Bun.sleep(5_100);
    expect((await refresh(proxy.id)).state).toBe("invalid_response");
    mode = "html";
    await Bun.sleep(5_100);
    expect(await refresh(proxy.id)).toMatchObject({ state: "invalid_response", accounts: [] });
    mode = "ok";

    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const gone = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    proxy = await save(proxy.id, undefined, gone);
    expect((await refresh(proxy.id)).state).toBe("unreachable");

    proxy = await save(proxy.id, "", root);
    expect(proxy.managementKeySet).toBe(false);
    requests = [];
    expect((await refresh(proxy.id)).state).toBe("no_key");
    expect(requests).toEqual([]);
    // The proxy itself keeps working: its inference secret is untouched.
    expect(proxy.secretSet).toBe(true);
  }, 40_000);

  test("only proxies a profile uses are checked periodically, and only by their owner", async () => {
    proxy = await save(proxy.id, KEY);
    const use = gw.runtime.runPromise.bind(gw.runtime);
    expect(await use(InstanceStore.use((s) => s.managedProxies(gw.userId)))).toEqual([]);
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "accounts",
      create: true,
      label: "Accounts",
      kind: ProviderProfileKind.CLIPROXYAPI,
      proxyId: proxy.id,
      allWorkers: true,
    });
    expect(await use(InstanceStore.use((s) => s.managedProxies(gw.userId)))).toEqual([proxy.id]);

    const other = await use(GatewayStore.use((s) => s.ensureUser("accounts-other@example.test", "Other")));
    expect(await use(InstanceStore.use((s) => s.managedProxies(other)))).toEqual([]);
    expect(await use(InstanceStore.use((s) => s.listProxies(other)))).toEqual([]);
    expect(await use(InstanceStore.use((s) => s.proxyManagement(other, proxy.id)).pipe(Effect.flip))).toMatchObject({
      message: "proxy not found",
    });
    await expect(gw.api.refreshProxyAccounts({ id: crypto.randomUUID() })).rejects.toThrow();
    // The periodic check reads the proxy in use once its last read is no longer fresh.
    await query("UPDATE proxies SET management_status = NULL, management_read_at = NULL WHERE id = $1::uuid", [
      proxy.id,
    ]);
    requests = [];
    await gw.core.proxyAccounts.check();
    expect(requests).toEqual(["key"]);
  });

  test("echoed management keys and proxy secrets never leave the gateway, raw or encoded", async () => {
    mode = "echo";
    await Bun.sleep(5_100);
    const accounts = await refresh(proxy.id);
    mode = "ok";

    expect(accounts.state).toBe("ok");

    const sent = [
      toJsonString(ui.ProxyAccountsSchema, accounts),
      toJsonString(ui.ListProxiesResponseSchema, await gw.api.listProxies({})),
    ].join("\n");

    for (const leaked of [
      KEY,
      SECRET,
      encodeURIComponent(KEY),
      encodeURIComponent(SECRET),
      base64(KEY),
      base64(KEY).replace(/=+$/, ""),
      base64(SECRET),
      Buffer.from(KEY).toString("base64url"),
    ])
      expect(sent).not.toContain(leaked);
    expect(accounts.accounts[0]?.detail).toContain("[redacted]");
  }, 30_000);

  test("an endless 403 body is read only as a short prefix", async () => {
    mode = "endless403";
    await Bun.sleep(5_100);
    const started = Date.now();
    const accounts = await refresh(proxy.id);
    mode = "ok";

    expect(accounts.state).toBe("remote_disabled");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  test("a rejected key stays rejected after a restart and across gateway processes until the key changes", async () => {
    proxy = await save(proxy.id, WRONG);
    await eventually(
      async () => (await gw.api.listProxies({})).proxies.find((p) => p.id === proxy.id)?.accounts?.state,
      (state) => state === "unauthorized",
    );
    requests = [];

    // Fresh monitors stand for a restarted gateway and a second gateway process: neither sends the key again.
    for (const restarted of [new ProxyAccountsMonitor(gw.core), new ProxyAccountsMonitor(gw.core)]) {
      await restarted.check();
      expect((await restarted.refresh(proxy.id)).state).toBe("unauthorized");
    }

    expect(requests).toEqual([]);

    // A new key reads again, and two processes opening the view at once send one request.
    proxy = await save(proxy.id, KEY);
    await eventually(
      async () => (await gw.api.listProxies({})).proxies.find((p) => p.id === proxy.id)?.accounts?.state,
      (state) => state === "ok",
    );
    await query("UPDATE proxies SET management_status = NULL, management_read_at = NULL WHERE id = $1::uuid", [
      proxy.id,
    ]);
    requests = [];
    const [a, b] = [new ProxyAccountsMonitor(gw.core), new ProxyAccountsMonitor(gw.core)];
    await Promise.all([a.refresh(proxy.id), b.refresh(proxy.id)]);
    expect(requests).toEqual(["key"]);
  }, 30_000);
});
