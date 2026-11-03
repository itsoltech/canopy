import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startConnectHttpServer, type RunningGrpcServer } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { mobileClient } from "../../apps/mobile/src/api/client.ts";
import { SERVICE_TOKEN, eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("mobile pairing + native app Connect client over HTTP/1.1", () => {
  let gw: TestGateway;
  let http: RunningGrpcServer;
  const client = (token?: string) => mobileClient({ gatewayUrl: http.url, ...(token && { token }), fetch: globalThis.fetch, development: true });
  const query = (text: string, params: unknown[] = []) => gw.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(text, params);
  }));
  const invite = () => gw.api.createMobilePairing({});
  const exchange = (code: string, name = "Test iPhone") => client().pairing.exchangeMobilePairing({ code, name, platform: "ios" });

  beforeAll(async () => {
    gw = await startTestGateway();
    http = await startConnectHttpServer({
      routes: (router) => { gw.core.mobile.routes(router); uiRoutes(gw.core)(router); },
      interceptors: [serviceTokenAuth(SERVICE_TOKEN, gw.core.mobile)],
    });
  }, 60_000);
  afterAll(async () => { await http?.close(100); await gw?.close(); });

  test("code exchanges atomically once; only hashes persist, with owner/name/platform metadata", async () => {
    const invitation = await invite();
    expect(invitation.code).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
    const expires = Number(invitation.pairing!.expiresAt!.seconds) * 1000;
    expect(expires - Date.now()).toBeGreaterThan(590_000);
    const attempts = await Promise.allSettled([exchange(invitation.code), exchange(invitation.code)]);
    const successes = attempts.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
    expect(successes).toHaveLength(1);
    const result = successes[0]!;
    expect(result.device).toMatchObject({ name: "Test iPhone", platform: "ios" });
    const rows = await query("SELECT d.owner_user_id, d.token_hash, p.code_hash, p.used_at, p.device_id FROM mobile_devices d JOIN mobile_pairings p ON p.device_id = d.id WHERE d.id = $1", [result.device!.id]);
    expect(rows[0]?.["owner_user_id"]).toBe(gw.userId);
    expect(rows[0]?.["token_hash"]).toBe(createHash("sha256").update(result.deviceToken).digest("hex"));
    expect(rows[0]?.["code_hash"]).toBe(createHash("sha256").update(invitation.code.replaceAll("-", "")).digest("hex"));
    expect(rows[0]?.["used_at"]).toBeDefined();
    expect((await gw.api.getMobileDevices({})).devices.some((d) => d.id === result.device!.id && d.lastSeenAt)).toBe(true);
    expect(await failure(exchange(invitation.code))).toContain("already used");
  });

  test("expired and revoked codes fail; invalid exchanges do not consume a valid code", async () => {
    const expired = await invite();
    await query("UPDATE mobile_pairings SET created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [expired.pairing!.id]);
    expect(await failure(exchange(expired.code))).toContain("expired");
    const revoked = await invite();
    await gw.api.revokeMobilePairing({ id: revoked.pairing!.id });
    expect(await failure(exchange(revoked.code))).toContain("revoked");
    const valid = await invite();
    expect(await failure(client().pairing.exchangeMobilePairing({ code: valid.code, name: "", platform: "android" }))).toContain("device name");
    expect(await failure(client().pairing.exchangeMobilePairing({ code: valid.code, name: "Browser", platform: "web" }))).toContain("platform");
    expect((await exchange(valid.code)).deviceToken).toStartWith("oa_device_");
  });

  test("device authorizes GatewayService, cannot administer pairing; revocation closes existing streams and rejects new RPCs", async () => {
    const paired = await exchange((await invite()).code);
    const phone = client(paired.deviceToken).api;
    expect((await phone.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
    expect(await failure(phone.createMobilePairing({}))).toContain("web Settings");
    expect(await failure(phone.getMobileDevices({}))).toContain("web Settings");
    const signal = AbortSignal.timeout(5000);
    const watch = phone.watchOverview({ includeSnapshot: true }, { signal })[Symbol.asyncIterator]();
    expect((await watch.next()).value?.change.case).toBe("mobileSnapshot");
    // Drain any initial worker updates until the revoked stream completes.
    const ended = (async () => { while (!(await watch.next()).done) { /* no further access once canceled */ } })();
    await gw.api.revokeMobileDevice({ id: paired.device!.id });
    await ended;
    expect(await failure(phone.getOverview({}))).toContain("revoked");
    expect((await gw.api.getMobileDevices({})).devices.find((d) => d.id === paired.device!.id)?.revokedAt).toBeDefined();
    // Independent devices retain access.
    const other = await exchange((await invite()).code, "Android");
    expect((await client(other.deviceToken).api.getOverview({})).workers.length).toBeGreaterThan(0);
    await client(other.deviceToken).api.unpairMobileDevice({});
    expect(await failure(client(other.deviceToken).api.getOverview({}))).toContain("revoked");
  });

  test("app's pure-TS transport gets overview and receives snapshot + live WatchThread messages via HTTP/1.1", async () => {
    const paired = await exchange((await invite()).code);
    const api = client(paired.deviceToken).api;
    const overview = await api.getOverview({});
    const project = overview.projects.find((p) => p.kind === "scratch")!;
    const workspace = project.workspaces.find((w) => w.workerId === gw.workerId)!;
    const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX, title: "Mobile streaming transport" })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let snapshot = false;
    let live = false;
    try {
      for await (const update of api.watchThread({ threadId: thread.id }, { signal: controller.signal })) {
        if (update.change.case === "snapshot") {
          expect(update.change.value.thread?.id).toBe(thread.id);
          snapshot = true;
          await api.sendMessage({ threadId: thread.id, text: "Hello from a paired phone", clientRequestId: Bun.randomUUIDv7() });
        }
        if (update.change.case === "event" && update.change.value.event?.body.case === "itemCompleted" && update.change.value.event.body.value.item?.content.case === "agentMessage") {
          live = true; break;
        }
      }
    } finally { clearTimeout(timer); controller.abort(); }
    expect({ snapshot, live }).toEqual({ snapshot: true, live: true });
    expect((await client(SERVICE_TOKEN).api.getOverview({})).workers.length).toBeGreaterThan(0);
    expect((await gw.api.getOverview({})).workers.length).toBeGreaterThan(0); // existing h2c BFF path unchanged
    expect(await failure(client().api.getOverview({}))).toContain("token");
    expect(await failure(client("incorrect-service-token").api.getOverview({}))).toContain("token");
    const invalidBff = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gw.grpcUrl }));
    expect(await failure(invalidBff.getOverview({}))).toContain("token");
    expect((await fetch(http.url, { method: "OPTIONS", headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
  });

  test("exchange rate limit cannot be bypassed by changing code or forwarding headers", async () => {
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const error = await failure(client().pairing.exchangeMobilePairing({ code: String(i), name: "Phone", platform: "android" }, { headers: { "x-forwarded-for": `192.0.2.${i}` } }));
      if (error.includes("Too many pairing")) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});
