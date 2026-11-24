import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { usageSummary } from "@canopy/domain/usage-summary";
import { Effect, Match } from "effect";
import { SqlClient } from "effect/sql";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const KEY = "fixture-management-key";
const NOW = new Date("2026-11-14T10:00:00Z");
const RESET = "2026-11-16T10:00:00Z";
const HEADER_RESET = String(Date.parse(RESET) / 1000);

const passive = {
  observed_at: NOW.toISOString(),
  signals: {
    "anthropic-ratelimit-unified-7d-utilization": "0.55",
    "anthropic-ratelimit-unified-7d-reset": HEADER_RESET,
  },
};

const files = [
  { auth_index: "oauth", provider: "claude", account_type: "oauth", quota: passive },
  { auth_index: "key", provider: "claude", account_type: "api_key", quota: passive },
  { auth_index: "disabled", provider: "claude", account_type: "oauth", disabled: true },
  { auth_index: "login", provider: "claude", account_type: "oauth", requires_sign_in: true },
  { auth_index: "codex", provider: "codex", account_type: "oauth" },
];

let used = 83;
let reset = RESET;
let mode = "ok";
let requests: string[] = [];
let calls = 0;
let gw: TestGateway;
let proxyId: string;
let management: ReturnType<typeof Bun.serve>;

async function refresh() {
  await gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE proxies SET management_read_at = NULL WHERE id = ${proxyId}::uuid`;
    }),
  );

  return gw.api.refreshProxyAccounts({ id: proxyId, force: true });
}

describe.skipIf(!dockerAvailable)("Claude usage through the proxy management API", () => {
  beforeAll(async () => {
    management = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
        const path = new URL(request.url).pathname;
        requests.push(path);

        if (path === "/v0/management/auth-files") return Response.json({ files });
        expect(path).toBe("/v0/management/api-call");
        expect(request.method).toBe("POST");
        expect(await request.json()).toEqual({
          auth_index: "oauth",
          method: "GET",
          url: "https://api.anthropic.com/api/oauth/usage",
          header: {
            Authorization: "Bearer $TOKEN$",
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
          },
        });
        calls++;

        if (mode === "unsupported") return new Response(null, { status: 404 });

        if (mode === "huge") return new Response(" ".repeat(513 * 1024));

        if (mode === "redirect") return Response.redirect(`http://127.0.0.1:${management.port}/unexpected`, 307);

        return Response.json({
          status_code: Match.value(mode).pipe(
            Match.when("rate_limit", () => 429),
            Match.when("expired", () => 401),
            Match.orElse(() => 200),
          ),
          header: { "X-Private": [KEY] },
          body: JSON.stringify({
            five_hour: null,
            seven_day: { utilization: mode === "invalid" ? 101 : used, resets_at: reset },
            seven_day_opus: { utilization: mode === "opus_reached" ? 100 : 90, resets_at: reset },
            seven_day_sonnet: null,
            private_field: KEY,
          }),
        });
      },
    });
    gw = await startTestGateway();
    setSystemTime(NOW);

    const saved = await gw.api.saveProxy({
      name: "Live usage proxy",
      kind: "cliproxyapi",
      baseUrl: `http://127.0.0.1:${management.port}`,
      secret: "fixture-inference-secret",
      managementKey: KEY,
    });

    proxyId = saved.proxy!.id;
  }, 60_000);

  afterAll(async () => {
    setSystemTime();
    await gw?.close();
    await management?.stop(true);
  });

  test("vendor usage replaces stale passive headers and is shared with clients without credentials", async () => {
    const accounts = await refresh();
    const oauth = accounts.accounts.find((account) => account.id === "oauth")!;

    expect(accounts.state).toBe("ok");
    expect(oauth.windows.map((window) => [window.key, window.usedPercent, window.resetsAt?.seconds])).toEqual([
      ["seven_day", 83, BigInt(HEADER_RESET)],
      ["seven_day_opus", 90, BigInt(HEADER_RESET)],
    ]);
    expect(accounts.accounts.find((account) => account.id === "key")?.windows[0]?.usedPercent).toBeCloseTo(55);
    expect(calls).toBe(1);
    const listed = await gw.api.listProxies({});
    expect(listed.proxies.find((proxy) => proxy.id === proxyId)?.accounts).toEqual(accounts);
    expect(toJsonString(ui.ListProxiesResponseSchema, listed)).not.toContain(KEY);
    expect(toJsonString(ui.ListProxiesResponseSchema, listed)).not.toContain("private_field");

    // Opening the view again shares the cached result, without another vendor call.
    expect(await gw.api.refreshProxyAccounts({ id: proxyId })).toEqual(accounts);
    expect(calls).toBe(1);
  });

  test("a fresh zero after reset wins over a larger passive balance", async () => {
    const afterReset = new Date("2026-11-16T10:00:01Z");
    used = 0;
    reset = "2026-11-21T10:00:00Z";
    setSystemTime(afterReset);

    try {
      const accounts = await refresh();
      const weekly = accounts.accounts.find((account) => account.id === "oauth")?.windows[0];
      const cached = accounts.accounts.find((account) => account.id === "key")?.windows[0];

      expect(weekly).toMatchObject({ key: "seven_day", usedPercent: 0, reached: false });
      expect(weekly?.resetsAt?.seconds).toBe(BigInt(Date.parse(reset) / 1000));
      expect(weekly?.observedAt && timestampDate(weekly.observedAt)).toEqual(afterReset);
      expect(cached?.observedAt && timestampDate(cached.observedAt)).toEqual(NOW);
    } finally {
      setSystemTime(NOW);
    }
  });

  test("an exhausted model allowance does not erase the shared weekly balance", async () => {
    mode = "opus_reached";
    used = 83;
    await refresh();
    const listed = await gw.api.listProxies({});
    const proxy = listed.proxies.find((entry) => entry.id === proxyId)!;
    const oauth = proxy.accounts!.accounts.find((entry) => entry.id === "oauth")!;

    // Only this OAuth account participates, to isolate its shared allowance from the API-key fixture.
    const rows = usageSummary(
      [],
      [{ ...proxy, usedBy: ["claude/native"], accounts: { ...proxy.accounts!, accounts: [oauth] } }],
      NOW.getTime(),
    );

    expect(oauth.windows.find((window) => window.key === "seven_day_opus")?.reached).toBe(true);
    expect(rows[0]?.window?.percentLeft).toBeCloseTo(17);
  });

  test("unsupported, rejected, oversized, invalid and redirecting reads retain the passive fallback", async () => {
    for (const failure of ["unsupported", "rate_limit", "expired", "huge", "invalid", "redirect"]) {
      mode = failure;
      const accounts = await refresh();

      expect(accounts.state).toBe("ok");
      expect(accounts.accounts.find((account) => account.id === "oauth")?.windows[0]?.usedPercent).toBeCloseTo(55);
    }

    expect(requests).not.toContain("/unexpected");
  });
});
