import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { finishPushThread, openBadge, relayFixture } from "./support/mobile-push.ts";
import { nodePinnedTransport } from "./support/phone.ts";

const transport = nodePinnedTransport();

describe.skipIf(!dockerAvailable)("silent dismissal of pushes read on another device", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let input: Awaited<ReturnType<typeof relayFixture>>;
  const previewKey = randomBytes(32);

  const phone = (token?: string) =>
    routedMobileClient({ connection: gw.core.mobile.networkRoutes(), ...(token && { token }), transport });

  async function subscribedPhone(platform: "ios" | "android") {
    const { code } = await gw.api.createMobilePairing({});
    const paired = await phone().pairing.exchangeMobilePairing({ code, name: `Test ${platform}`, platform });
    const api = phone(paired.deviceToken).api;
    const expoToken = `ExpoPushToken[dismiss-${platform}-${crypto.randomUUID()}]`;
    await api.setMobilePushSubscription({ enabled: true, expoToken, previewKey: previewKey.toString("base64url") });

    return { api, deviceId: paired.device!.id, expoToken };
  }

  const query = <A extends object>(sql: string, values: unknown[] = []) => gw.core.linkedAgents.query<A>(sql, values);

  /** Delivers the finished turn and returns each phone's receipt for it. */
  async function deliveredThread() {
    const start = input.received.length;
    const threadId = await finishPushThread(gw);
    await gw.core.mobilePush.dispatch();
    const pushes = input.received.slice(start);
    const receipt = (token: string) => pushes.find((push) => push.token === token)!.receiptId;

    return { threadId, receipt };
  }

  async function readThread(threadId: string) {
    const { thread } = await gw.api.getThread({ threadId });
    await gw.api.markThreadSeen({ threadId, upToSeq: thread!.lastSeq });
  }

  async function dismissalsAfter(run: () => Promise<void>) {
    const start = input.dismissals.length;
    await run();
    await gw.core.mobilePush.dispatch();

    return input.dismissals.slice(start);
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

  test("a read on the computer sends each phone one silent dismissal, with the badge only for iOS", async () => {
    const ios = await subscribedPhone("ios");
    const android = await subscribedPhone("android");

    try {
      const first = await deliveredThread();
      expect(await dismissalsAfter(async () => {})).toEqual([]);

      const sent = await dismissalsAfter(() => readThread(first.threadId));
      expect(sent).toHaveLength(2);
      const toIos = sent.find((dismissal) => dismissal.token === ios.expoToken)!;
      const toAndroid = sent.find((dismissal) => dismissal.token === android.expoToken)!;
      expect(toIos).toMatchObject({ platform: "ios", receiptIds: [first.receipt(ios.expoToken)] });
      expect(toAndroid).toEqual({
        token: android.expoToken,
        platform: "android",
        dismissId: toAndroid.dismissId,
        receiptIds: [first.receipt(android.expoToken)],
      });
      expect(JSON.parse(openBadge(toIos.badge!, previewKey, toIos.dismissId))).toEqual({ badge: 0 });
      expect(() => openBadge(toIos.badge!, previewKey, toAndroid.dismissId)).toThrow();

      // Closed rows stay closed, and a phone that was just told waits out its throttle.
      expect(await dismissalsAfter(() => readThread(first.threadId))).toEqual([]);
      const second = await deliveredThread();
      expect(await dismissalsAfter(() => readThread(second.threadId))).toEqual([]);

      // Move the throttle into the past instead of waiting it out.
      const later = await dismissalsAfter(async () => {
        await query("UPDATE mobile_push_subscriptions SET last_dismissal_at = now() - interval '1 minute'");
        await query("UPDATE mobile_push_outbox SET dismiss_at = now() WHERE dismiss_at IS NOT NULL");
      });

      const laterIos = later.find((dismissal) => dismissal.token === ios.expoToken)!;
      // The earlier receipt rides along in case iOS dropped or coalesced the first silent push.
      expect(laterIos.receiptIds).toEqual([second.receipt(ios.expoToken), first.receipt(ios.expoToken)]);
    } finally {
      await Promise.all([ios.api.unpairMobileDevice({}), android.api.unpairMobileDevice({})]);
    }
  }, 30_000);

  test("a thread marked unread again keeps its push, and a relay without the route ends the attempt", async () => {
    const ios = await subscribedPhone("ios");

    try {
      const { threadId, receipt } = await deliveredThread();
      const id = receipt(ios.expoToken);

      const state = async () =>
        (
          await query<{ dismissed: boolean; due: boolean }>(
            `SELECT dismissed_at IS NOT NULL AS dismissed, dismiss_at IS NOT NULL AS due
              FROM mobile_push_outbox WHERE id = $1::uuid`,
            [id],
          )
        )[0];

      const unread = await dismissalsAfter(async () => {
        await readThread(threadId);
        await gw.api.setThreadRead({ threadId, unread: true });
      });

      expect(unread).toEqual([]);
      expect(await state()).toEqual({ dismissed: false, due: false });

      input.state.dismissStatus = 404;
      expect(await dismissalsAfter(() => readThread(threadId))).toEqual([]);
      input.state.dismissStatus = 204;
      expect(await state()).toEqual({ dismissed: true, due: false });
      expect(await dismissalsAfter(() => readThread(threadId))).toEqual([]);
    } finally {
      input.state.dismissStatus = 204;
      await ios.api.unpairMobileDevice({});
    }
  }, 30_000);
});
