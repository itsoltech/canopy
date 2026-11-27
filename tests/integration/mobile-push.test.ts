import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { pairDesktop } from "../../apps/desktop/src/remote-client.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { MobilePush } from "../../apps/gateway/src/push/mobile-push.ts";
import { relayPush } from "../../apps/gateway/src/push/relay.ts";
import { EnrollmentStore } from "../../apps/push-relay/src/enrollment-store.ts";
import { serveRelay } from "../../apps/push-relay/src/server.ts";
import { eventually, failure, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { finishPushThread, openPreview, readPush, relayCertificate, relayFixture } from "./support/mobile-push.ts";
import { nodePinnedTransport } from "./support/phone.ts";

const transport = nodePinnedTransport();
const canopyRelay = "https://notifications-relay.canopy.itsol.tech";

async function managedRelayFixture(path = ":memory:") {
  const tls = await relayCertificate();
  const store = new EnrollmentStore(path);
  const received: Array<Awaited<ReturnType<typeof readPush>>> = [];

  const readExpoMessage = Schema.decodeUnknownPromise(
    Schema.Struct({
      to: Schema.String,
      data: Schema.Struct({ receiptId: Schema.String, preview: Schema.String }),
    }),
  );

  const relay = serveRelay(
    {
      hostname: "127.0.0.1",
      port: 0,
      ...tls,
      expoAccessToken: "test-relay",
      enrollment: {
        store,
        verifier: {
          supports: (platform) => platform === "ios",
          verify: async ({ challenge, attestation }) => `test-proof.${challenge}` === attestation,
        },
      },
    },
    async (url, init) => {
      if (!url.endsWith("/push/send")) return new Response(null, { status: 404 });
      const { to: token, data } = await readExpoMessage(await new Response(init.body).json());
      received.push({ token, platform: "ios", ...data });

      return Response.json({ data: { status: "ok", id: "managed-ticket" } });
    },
  );

  return { relay, store, options: { origin: relay.url.origin, ca: tls.cert }, received };
}

function phoneProof(token: string, challenge: string) {
  const digest = createHash("sha256")
    .update(`canopy-push-enrollment-v1\nios\n${token}\n${challenge}`)
    .digest("base64url");

  return `test-proof.${digest}`;
}

async function seedBotPushes(gateway: TestGateway) {
  const query = gateway.core.linkedAgents.query.bind(gateway.core.linkedAgents);
  const botId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  await query(
    `INSERT INTO bots (id, owner_user_id, client_request_id, configuration, provider, provider_instance)
      VALUES ($1::uuid, $2::uuid, 'push-bot', '{"name":"Private bot"}', 'codex', 'native')`,
    [botId, gateway.userId],
  );
  await query(
    `INSERT INTO bot_turns (id, bot_id, client_request_id, input, status)
      VALUES ($1::uuid, $2::uuid, 'push-turn', '', 'waiting')`,
    [turnId, botId],
  );

  const [message] = await query<{ seq: string }>(
    `INSERT INTO bot_messages (id, bot_id, turn_id, message_key, sender_id, recipient_id, text)
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'push-message', $1::uuid::text, 'user', 'Private message') RETURNING seq`,
    [botId, turnId],
  );

  await query(
    `INSERT INTO bot_tool_calls (id, turn_id, call_key, tool, arguments)
      VALUES ($1::uuid, $2::uuid, 'push-question', '{}', '{}')`,
    [approvalId, turnId],
  );
  await query(
    `INSERT INTO bot_approvals (id, bot_id, turn_id, kind, prompt, expires_at)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'question', 'Private question', now() + interval '1 day')`,
    [approvalId, botId, turnId],
  );

  return { botId, approvalId, seq: BigInt(message!.seq) };
}

describe.skipIf(!dockerAvailable)("mobile push from durable gateway events", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let input: Awaited<ReturnType<typeof relayFixture>>;

  const phone = (token?: string) =>
    routedMobileClient({
      connection: gw.core.mobile.networkRoutes(),
      ...(token && { token }),
      transport,
    });

  async function pair(platform = "ios") {
    const { code } = await gw.api.createMobilePairing({});

    return phone().pairing.exchangeMobilePairing({ code, name: "Test phone", platform });
  }

  beforeAll(async () => {
    input = await relayFixture();
    gw = await startTestGateway({ mobilePush: input.options });
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  }, 60_000);

  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
    await input?.relay.stop(true);
  });

  test("a server grants relay settings to its BFF and paired desktops", async () => {
    const caps = await gw.api.getClientCapabilities({});
    expect(caps.pushRelaySettings).toBe(true);
    expect(caps.localPushRelaySettings).toBe(false);
    const { origin, bearer, ca } = input.options;
    const settings = create(ui.PushRelaySettingsSchema, { origin, hasPrivateCa: true, managedOrigin: canopyRelay });
    expect(await gw.api.getPushRelaySettings({})).toEqual(settings);

    const desktop = await pairDesktop(
      toJsonString(ui.CreateMobilePairingResponseSchema, await gw.api.createDesktopPairing({})),
    );

    const remote = phone(desktop.token).api;
    expect((await remote.getClientCapabilities({})).pushRelaySettings).toBe(true);
    expect(await remote.getPushRelaySettings({})).toEqual(settings);

    try {
      expect((await remote.updatePushRelaySettings({ origin, caPem: "" })).hasPrivateCa).toBe(false);
      expect((await gw.api.getPushRelaySettings({})).hasPrivateCa).toBe(false);
      expect(await remote.updatePushRelaySettings({ useManaged: true })).toEqual(
        create(ui.PushRelaySettingsSchema, {
          managedOrigin: canopyRelay,
          managedAvailable: true,
          managedEnabled: true,
        }),
      );
      expect(await remote.updatePushRelaySettings({ origin, bearer, caPem: ca })).toEqual(settings);
    } finally {
      await gw.api.updatePushRelaySettings({ origin, bearer, caPem: ca });
    }

    await gw.api.revokeMobileDevice({ id: desktop.deviceId });
    expect(await connectCode(remote.updatePushRelaySettings({ remove: true }))).toBe(Code.Unauthenticated);

    const paired = await pair();
    const subscriber = phone(paired.deviceToken).api;
    expect((await subscriber.getClientCapabilities({})).pushRelaySettings).toBe(false);
    expect(await connectCode(subscriber.getPushRelaySettings({}))).toBe(Code.PermissionDenied);
    expect(await connectCode(subscriber.updatePushRelaySettings({ remove: true }))).toBe(Code.PermissionDenied);
    expect(await connectCode(phone(SERVICE_TOKEN).api.updatePushRelaySettings({ remove: true }))).toBe(
      Code.PermissionDenied,
    );
  });

  test("the gateway refuses to send a registration to an untrusted relay certificate", async () => {
    const { origin, bearer } = input.options;

    const result = await relayPush(
      { origin, bearer },
      { token: "ExpoPushToken[test-device]", platform: "ios", receiptId: crypto.randomUUID(), preview: "stub" },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("retry");
    expect(input.received).toHaveLength(0);
  });

  test("a restarted sender encrypts the preview and only the registered phone can resolve the receipt", async () => {
    await finishPushThread(gw, true);
    const paired = await pair();
    const subscriber = phone(paired.deviceToken).api;
    const otherPhone = phone((await pair()).deviceToken).api;
    const token = "ExpoPushToken[test-device]";
    const key = randomBytes(32);
    const registration = { enabled: true, expoToken: token, previewKey: key.toString("base64url") };
    expect((await subscriber.getClientCapabilities({})).mobilePush).toBe(true);
    expect(await failure(gw.api.setMobilePushSubscription(registration))).toContain("Mobile device token required");
    await subscriber.setMobilePushSubscription(registration);

    const threadId = await finishPushThread(gw);
    const restarted = new MobilePush(gw.runtime, gw.userId, { ...input.options, secretsKey: gw.secretsKey });

    try {
      await restarted.dispatch();
      await restarted.dispatch();
      expect(input.received).toHaveLength(1);
      const payload = input.received[0]!;
      expect(payload).toMatchObject({ token, platform: "ios" });
      expect(payload).not.toHaveProperty("badge");
      expect(JSON.stringify(payload)).not.toContain("Private");
      expect(JSON.stringify(payload)).not.toContain(threadId);
      expect(JSON.stringify(payload)).not.toContain(registration.previewKey);
      expect(openPreview(payload, key)).toBe(
        JSON.stringify({ title: "Private title", body: "Finished · Echo: Private reply", badge: 1 }),
      );
      expect(() => openPreview(payload, key, crypto.randomUUID())).toThrow();

      const receiptId = payload.receiptId;
      expect((await subscriber.resolveMobilePush({ receiptId })).destination).toEqual({
        case: "threadId",
        value: threadId,
      });
      expect(await failure(otherPhone.resolveMobilePush({ receiptId }))).toContain(
        "Notification is no longer available",
      );
      const { thread } = await gw.api.getThread({ threadId });
      expect(thread?.unseenResult).toBe("completed");
      expect((await subscriber.listDismissibleMobilePush({ receiptIds: [receiptId] })).receiptIds).toEqual([]);

      await gw.api.sendMessage({ threadId, text: "Another reply", clientRequestId: "push-2" });
      await eventually(
        () => gw.api.getThread({ threadId }),
        (result) => result.thread?.noticePreview.includes("Another reply") === true,
      );
      await restarted.dispatch();
      expect(input.received).toHaveLength(2);
      const newer = input.received[1]!.receiptId;

      await subscriber.markThreadSeen({ threadId, upToSeq: thread!.lastSeq });
      const receipts = { receiptIds: [receiptId, newer, crypto.randomUUID()] };
      expect((await subscriber.listDismissibleMobilePush(receipts)).receiptIds).toEqual([receiptId]);
      expect((await otherPhone.listDismissibleMobilePush(receipts)).receiptIds).toEqual([]);
      expect(await connectCode(gw.api.listDismissibleMobilePush(receipts))).toBe(Code.Unauthenticated);
      await gw.api.setThreadRead({ threadId, unread: true });
      await gw.api.revokeMobileDevice({ id: paired.device!.id });
      expect(await failure(subscriber.resolveMobilePush({ receiptId }))).toContain("revoked device token");
      expect(await connectCode(subscriber.listDismissibleMobilePush(receipts))).toBe(Code.Unauthenticated);
    } finally {
      await restarted.close();
    }
  }, 30_000);

  test("iOS previews share the absolute badge and Android can dismiss read bot pushes", async () => {
    await finishPushThread(gw);
    const ios = phone((await pair()).deviceToken).api;
    const android = phone((await pair("android")).deviceToken).api;
    const previewKey = randomBytes(32);
    const registration = { enabled: true, previewKey: previewKey.toString("base64url") };
    const start = input.received.length;

    try {
      await ios.setMobilePushSubscription({ ...registration, expoToken: "ExpoPushToken[bot-ios]" });
      await android.setMobilePushSubscription({ ...registration, expoToken: "ExpoPushToken[bot-android]" });
      const { botId, approvalId, seq } = await seedBotPushes(gw);
      await gw.core.mobilePush.dispatch();
      const batch = input.received.slice(start);
      expect(batch).toHaveLength(4);

      const receipt = (platform: string, body: string, badge?: number) => {
        const preview = JSON.stringify({ title: "Private bot", body, badge });

        const push = batch.find(
          (payload) => payload.platform === platform && openPreview(payload, previewKey) === preview,
        );

        expect(push).toBeDefined();

        return push!.receiptId;
      };

      receipt("ios", "New message · Private message", 3);
      receipt("ios", "Needs your answer · Private question", 3);
      const message = receipt("android", "New message · Private message");
      const approval = receipt("android", "Needs your answer · Private question");
      const receipts = { receiptIds: [message, approval] };
      expect((await android.listDismissibleMobilePush(receipts)).receiptIds).toEqual([]);
      await gw.api.markBotRead({ botId, throughSeq: seq });
      expect((await android.listDismissibleMobilePush(receipts)).receiptIds).toEqual([message]);

      await gw.core.linkedAgents.query("UPDATE bot_approvals SET expires_at = now() WHERE id = $1::uuid", [approvalId]);
      expect(new Set((await android.listDismissibleMobilePush(receipts)).receiptIds)).toEqual(
        new Set([message, approval]),
      );
      expect((await ios.listDismissibleMobilePush(receipts)).receiptIds).toEqual([]);
    } finally {
      await Promise.all([ios.unpairMobileDevice({}), android.unpairMobileDevice({})]);
    }
  }, 30_000);

  test("snoozing pauses queued push and drops events generated during the snooze", async () => {
    const paired = await pair();
    const subscriber = phone(paired.deviceToken).api;
    const received = input.received.length;

    try {
      await subscriber.setMobilePushSubscription({
        enabled: true,
        expoToken: "ExpoPushToken[snooze-test]",
        previewKey: randomBytes(32).toString("base64url"),
      });
      const queued = await finishPushThread(gw);
      await gw.api.setThreadSnooze({ threadId: queued, snoozed: true });
      const muted = await finishPushThread(gw, true);
      await gw.core.mobilePush.dispatch();
      expect(input.received).toHaveLength(received);

      await gw.api.setThreadSnooze({ threadId: queued, snoozed: false });
      await gw.api.setThreadSnooze({ threadId: muted, snoozed: false });
      await gw.core.mobilePush.dispatch();
      expect(input.received).toHaveLength(received + 1);
      expect(
        (await subscriber.resolveMobilePush({ receiptId: input.received[received]!.receiptId })).destination,
      ).toEqual({ case: "threadId", value: queued });
    } finally {
      await subscriber.unpairMobileDevice({});
    }
  }, 30_000);
});

const connectCode = (request: Promise<unknown>) =>
  request.then(
    () => undefined,
    (error) => ConnectError.from(error).code,
  );

async function desktopNetwork(gateway: TestGateway) {
  const network = new NetworkAccess({
    role: "desktop",
    store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
    host: "127.0.0.1",
  });

  gateway.core.network = network;
  const unmount = mountMobileNetwork(gateway.core, network, SERVICE_TOKEN);
  await network.start();
  await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));

  return async () => {
    unmount();
    await network.close();
  };
}

describe.skipIf(!dockerAvailable)("local Desktop relay configuration", () => {
  test("the local BFF configures push without restarting and keeps the settings across a restart", async () => {
    const input = await relayFixture();
    let gateway = await startTestGateway({ role: "desktop" });
    let closeNetwork: (() => Promise<void>) | undefined;

    const phone = (token?: string) =>
      routedMobileClient({
        connection: gateway.core.mobile.networkRoutes(),
        ...(token && { token }),
        transport,
      });

    try {
      closeNetwork = await desktopNetwork(gateway);
      const { code } = await gateway.api.createMobilePairing({});

      const { deviceToken } = await phone().pairing.exchangeMobilePairing({
        code,
        name: "Test phone",
        platform: "ios",
      });

      const subscriber = phone(deviceToken).api;
      const serviceOnNetwork = phone(SERVICE_TOKEN).api;
      const { origin, bearer, ca } = input.options;
      expect((await gateway.api.getClientCapabilities({})).localPushRelaySettings).toBe(true);
      expect((await subscriber.getClientCapabilities({})).mobilePush).toBe(false);
      expect((await subscriber.getClientCapabilities({})).localPushRelaySettings).toBe(false);
      expect(await connectCode(subscriber.getPushRelaySettings({}))).toBe(Code.PermissionDenied);
      expect(await connectCode(serviceOnNetwork.updatePushRelaySettings({ origin, bearer }))).toBe(
        Code.PermissionDenied,
      );
      expect(
        await connectCode(gateway.api.updatePushRelaySettings({ origin: origin.replace("https:", "http:"), bearer })),
      ).toBe(Code.InvalidArgument);

      const saved = await gateway.api.updatePushRelaySettings({ origin, bearer, ...(ca && { caPem: ca }) });
      expect(saved).toEqual(
        create(ui.PushRelaySettingsSchema, { origin, hasPrivateCa: true, managedOrigin: canopyRelay }),
      );
      expect((await subscriber.getClientCapabilities({})).mobilePush).toBe(true);
      expect(await connectCode(gateway.api.updatePushRelaySettings({ origin: "https://other.example" }))).toBe(
        Code.InvalidArgument,
      );
      expect(await gateway.api.updatePushRelaySettings({ origin })).toEqual(saved);
      expect((await gateway.api.updatePushRelaySettings({ origin, caPem: "" })).hasPrivateCa).toBe(false);
      expect(await gateway.api.updatePushRelaySettings({ origin, ...(ca && { caPem: ca }) })).toEqual(saved);

      const previewKey = randomBytes(32);
      await subscriber.setMobilePushSubscription({
        enabled: true,
        expoToken: "ExpoPushToken[desktop-test]",
        previewKey: previewKey.toString("base64url"),
      });
      await closeNetwork();
      closeNetwork = undefined;
      await gateway.close(true);
      const prior = gateway;

      try {
        gateway = await startTestGateway({ role: "desktop", storage: prior });
      } catch (error) {
        await prior.pg.stop();
        throw error;
      }

      closeNetwork = await desktopNetwork(gateway);
      expect(await gateway.api.getPushRelaySettings({})).toEqual(saved);
      expect((await phone(deviceToken).api.getClientCapabilities({})).mobilePush).toBe(true);
      await finishPushThread(gateway);
      // Dispatch after the restart uses the stored settings and the original phone subscription.
      await gateway.core.mobilePush.dispatch();
      expect(input.received).toHaveLength(1);
      expect(openPreview(input.received[0]!, previewKey)).toContain("Finished · Echo: Private reply");
      expect(await gateway.api.updatePushRelaySettings({ remove: true })).toEqual(
        create(ui.PushRelaySettingsSchema, { managedOrigin: canopyRelay }),
      );
      expect((await phone(deviceToken).api.getClientCapabilities({})).mobilePush).toBe(false);
    } finally {
      await closeNetwork?.();
      await gateway.close();
      await input.relay.stop(true);
    }
  }, 60_000);
});

describe.skipIf(!dockerAvailable)("server relay configuration", () => {
  test("a saved override and its removal both take precedence over deployment defaults after restart", async () => {
    const defaults = { origin: "https://default-relay.example", bearer: randomBytes(32).toString("base64url") };
    const managed = { origin: "https://canopy-relay.example" };
    const storedOrigin = "https://custom-relay.example";
    let gateway = await startTestGateway({ mobilePush: defaults, managedMobilePush: managed });

    async function restart() {
      await gateway.close(true);

      return startTestGateway({ storage: gateway, mobilePush: defaults, managedMobilePush: managed });
    }

    try {
      expect((await gateway.api.getPushRelaySettings({})).origin).toBe(defaults.origin);
      expect(await connectCode(gateway.api.updatePushRelaySettings({ origin: storedOrigin }))).toBe(
        Code.InvalidArgument,
      );

      const stored = await gateway.api.updatePushRelaySettings({
        origin: storedOrigin,
        bearer: randomBytes(32).toString("base64url"),
      });

      const expected = create(ui.PushRelaySettingsSchema, {
        origin: storedOrigin,
        managedAvailable: true,
        managedByDefault: true,
        managedOrigin: managed.origin,
      });

      expect(stored).toEqual(expected);

      gateway = await restart();
      expect(await gateway.api.getPushRelaySettings({})).toEqual(expected);
      expect(await gateway.api.updatePushRelaySettings({ remove: true })).toEqual(
        create(ui.PushRelaySettingsSchema, {
          managedAvailable: true,
          managedByDefault: true,
          managedEnabled: true,
          managedOrigin: managed.origin,
        }),
      );

      gateway = await restart();
      expect((await gateway.api.getPushRelaySettings({})).origin).toBe("");
      expect(gateway.core.mobilePush.managedAvailable).toBe(true);
      expect(gateway.core.mobilePush.manualAvailable).toBe(false);
    } finally {
      await gateway.close();
    }
  }, 60_000);

  test("a server can opt in to the Canopy relay and turn it off across restarts", async () => {
    let gateway = await startTestGateway();

    async function restart() {
      await gateway.close(true);

      return startTestGateway({ storage: gateway });
    }

    try {
      const disabled = create(ui.PushRelaySettingsSchema, { managedOrigin: canopyRelay });

      const enabled = create(ui.PushRelaySettingsSchema, {
        managedOrigin: canopyRelay,
        managedEnabled: true,
        managedAvailable: true,
      });

      expect(await gateway.api.getPushRelaySettings({})).toEqual(disabled);
      expect(await connectCode(gateway.api.updatePushRelaySettings({ useManaged: true, remove: true }))).toBe(
        Code.InvalidArgument,
      );
      expect(await gateway.api.updatePushRelaySettings({ useManaged: true })).toEqual(enabled);

      gateway = await restart();

      expect(await gateway.api.getPushRelaySettings({})).toEqual(enabled);
      expect(gateway.core.mobilePush.managedAvailable).toBe(true);
      expect(await gateway.api.updatePushRelaySettings({ remove: true })).toEqual(disabled);

      gateway = await restart();

      expect(await gateway.api.getPushRelaySettings({})).toEqual(disabled);
      expect(gateway.core.mobilePush.managedAvailable).toBe(false);
    } finally {
      await gateway.close();
    }
  }, 60_000);
});

describe.skipIf(!dockerAvailable)("attested Desktop relay enrollment", () => {
  test("reattestation keeps the current subscription and unpairing revokes the grant after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-managed-push-"));
    const path = join(directory, "enrollment.sqlite");
    let input: Awaited<ReturnType<typeof managedRelayFixture>> | undefined;
    let gateway: TestGateway | undefined;
    let stopNetwork: (() => Promise<void>) | undefined;

    try {
      input = await managedRelayFixture(path);
      const previous = await startTestGateway({ role: "desktop", managedMobilePush: input.options });
      gateway = previous;
      stopNetwork = await desktopNetwork(previous);
      const connection = previous.core.mobile.networkRoutes();
      const app = routedMobileClient({ connection, transport });
      const { code } = await previous.api.createMobilePairing({});
      const { deviceToken: token } = await app.pairing.exchangeMobilePairing({ code, name: "Phone", platform: "ios" });
      const phone = routedMobileClient({ connection, token, transport }).api;
      const expoToken = "ExpoPushToken[renewing-phone]";
      const previewKey = randomBytes(32).toString("base64url");
      const keyId = randomBytes(32).toString("base64");

      const attest = (enrollment: ui.BeginManagedMobilePushResponse) =>
        phone.completeManagedMobilePush({
          enrollmentId: enrollment.enrollmentId,
          attestation: phoneProof(expoToken, enrollment.challenge),
          keyId,
          previewKey,
        });

      await attest(await phone.beginManagedMobilePush({ expoToken }));
      const threadId = await finishPushThread(previous);
      await previous.core.mobilePush.dispatch();
      const [push] = input.received;
      expect(push).toBeDefined();

      // Advance the stored deadlines to the renewal window while keeping real TLS and provider requests.
      using state = new Database(path);
      state.query("UPDATE grants SET hard_expires_at = ?").run(Date.now() + 30 * 86_400_000);
      await previous.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE mobile_push_grants SET expires_at = now() + interval '6 days'`;
        }),
      );

      const refresh = await phone.beginManagedMobilePush({ expoToken });
      expect(refresh.refreshExistingGrant).toBe(true);
      await phone.setMobilePushSubscription({ enabled: true, expoToken, previewKey });

      // With the app interrupted before completion, the next opening still attempts a passive refresh.
      const retry = await phone.beginManagedMobilePush({ expoToken });
      expect(retry.refreshExistingGrant).toBe(true);
      expect(retry.enrollmentId).not.toBe(refresh.enrollmentId);
      await attest(retry);
      expect((await phone.beginManagedMobilePush({ expoToken })).enrollmentId).toBe("");
      expect((await phone.resolveMobilePush({ receiptId: push!.receiptId })).destination).toEqual({
        case: "threadId",
        value: threadId,
      });

      const grant = state.query<{ bearer_hash: string }, []>("SELECT bearer_hash FROM grants").get();
      expect(grant !== null).toBe(true);
      await phone.unpairMobileDevice({});
      await stopNetwork();
      stopNetwork = undefined;
      await previous.close(true);
      gateway = undefined;

      try {
        gateway = await startTestGateway({ role: "desktop", storage: previous, managedMobilePush: input.options });
      } catch (error) {
        await previous.pg.stop();
        throw error;
      }

      await gateway.core.mobilePush.dispatch();
      expect(Boolean(input.store.find(grant!.bearer_hash))).toBe(false);
    } finally {
      await stopNetwork?.();
      await gateway?.close();
      await input?.relay.stop(true);
      input?.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("activation binds the attested app token to its paired phone and enables encrypted delivery", async () => {
    const input = await managedRelayFixture();
    let gateway: TestGateway | undefined;
    let closeNetwork: (() => Promise<void>) | undefined;

    try {
      const desktop = await startTestGateway({ role: "desktop", managedMobilePush: input.options });
      gateway = desktop;
      closeNetwork = await desktopNetwork(desktop);
      const connection = desktop.core.mobile.networkRoutes();
      const app = routedMobileClient({ connection, transport });

      const pair = async () => {
        const { code } = await desktop.api.createMobilePairing({});

        const { deviceToken: token } = await app.pairing.exchangeMobilePairing({
          code,
          name: "Test phone",
          platform: "ios",
        });

        return routedMobileClient({ connection, token, transport }).api;
      };

      const ownerPhone = await pair();
      const otherPhone = await pair();
      const expoToken = "ExpoPushToken[test-attested-phone]";
      const keyId = randomBytes(32).toString("base64");
      const key = randomBytes(32);
      const previewKey = key.toString("base64url");
      expect(await connectCode(desktop.api.beginManagedMobilePush({ expoToken }))).toBe(Code.Unauthenticated);
      expect((await ownerPhone.getClientCapabilities({})).managedMobilePush).toBe(true);
      expect((await ownerPhone.getClientCapabilities({})).mobilePush).toBe(false);

      const first = await ownerPhone.beginManagedMobilePush({ expoToken });

      const incorrect = {
        enrollmentId: first.enrollmentId,
        attestation: phoneProof("ExpoPushToken[different-phone]", first.challenge),
        keyId,
        previewKey,
      };

      expect(
        await connectCode(
          otherPhone.completeManagedMobilePush({ ...incorrect, attestation: phoneProof(expoToken, first.challenge) }),
        ),
      ).toBe(Code.FailedPrecondition);
      expect(await connectCode(ownerPhone.completeManagedMobilePush(incorrect))).toBe(Code.FailedPrecondition);
      expect(await connectCode(ownerPhone.setMobilePushSubscription({ enabled: true, expoToken, previewKey }))).toBe(
        Code.FailedPrecondition,
      );

      const second = await ownerPhone.beginManagedMobilePush({ expoToken });
      expect(second.enrollmentId).not.toBe(first.enrollmentId);
      await ownerPhone.completeManagedMobilePush({
        ...incorrect,
        enrollmentId: second.enrollmentId,
        attestation: phoneProof(expoToken, second.challenge),
      });
      expect((await ownerPhone.beginManagedMobilePush({ expoToken })).enrollmentId).toBe("");

      const threadId = await finishPushThread(desktop);
      await desktop.core.mobilePush.dispatch();

      const [push] = await eventually(
        async () => input.received,
        (received) => received.length === 1,
      );

      expect(push?.token).toBe(expoToken);
      expect(openPreview(push!, key)).toContain("Finished · Echo: Private reply");
      expect((await ownerPhone.resolveMobilePush({ receiptId: push!.receiptId })).destination).toEqual({
        case: "threadId",
        value: threadId,
      });
    } finally {
      await closeNetwork?.();
      await gateway?.close();
      await input.relay.stop(true);
      input.store.close();
    }
  }, 60_000);
});
