import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { routedPinnedTransport } from "@canopy/transport";
import { routedMobileClient, type MobileConnection } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("paired phone port changes", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  const transport = nodePinnedTransport();

  beforeAll(async () => {
    gw = await startTestGateway();
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await gw.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  async function paired() {
    const connection = gw.core.mobile.networkRoutes();
    const invitation = await gw.api.createMobilePairing({});
    const client = routedMobileClient({ connection, transport });

    return client.pairing.exchangeMobilePairing({ code: invitation.code, name: "Port phone", platform: "android" });
  }

  test.each(["set_port", "choose_port"])(
    "%s response saves new routes without an overview stream",
    async (action) => {
      const pairing = await paired();
      const original = gw.core.mobile.networkRoutes();
      const file = join(tempDir("canopy-phone-routes-"), "routes.json");
      let saving: Promise<number> | undefined;

      const phone = routedMobileClient({
        connection: original,
        token: pairing.deviceToken,
        transport,
        changed: (routes) => {
          saving = Bun.write(file, JSON.stringify(routes));
        },
      });

      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      // SAFETY: the reservation is listening on a TCP host/port.
      const spare = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const changed = await phone.api.updateNetworkAccess({ action, port: spare });
      expect(changed.state).toBe("on");
      expect(changed.port).not.toBe(Number(new URL(original.addresses[0]!).port));
      expect(changed.fingerprint).toBe(original.fingerprint);
      expect(phone.connection().addresses).toEqual(changed.addresses.map((a) => a.origin));
      await saving;
      const saved: MobileConnection = await Bun.file(file).json();
      expect(saved.addresses).toEqual(network.origins());
      expect(saved.lastAddress).not.toBe(original.addresses[0]);
      const restarted = routedMobileClient({ connection: saved, token: pairing.deviceToken, transport });
      expect((await restarted.api.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
      expect(restarted.connection().lastAddress).toBe(network.origins()[0]);
      expect(
        (await restarted.api.getMobileDevices({})).devices.find((d) => d.id === pairing.device!.id)?.revokedAt,
      ).toBeUndefined();
    },
    15_000,
  );

  test.each(["http1", "http2"])(
    "%s overview advertises routes before its old connection retires",
    async (protocol) => {
      const pairing = await paired();
      const original = gw.core.mobile.networkRoutes();
      const pinned = protocol === "http2" ? routedPinnedTransport(original, pairing.deviceToken) : undefined;
      const phone = routedMobileClient({ connection: original, token: pairing.deviceToken, transport });
      const api = pinned ? createClient(ui.GatewayService, pinned.transport) : phone.api;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const watch = api.watchOverview({ includeSnapshot: true }, { signal: controller.signal })[Symbol.asyncIterator]();

      try {
        expect((await watch.next()).value?.change.case).toBe("mobileSnapshot");
        const changed = await api.updateNetworkAccess({ action: "choose_port" });

        const routes = await (async () => {
          for (;;) {
            const next = await watch.next();

            if (next.done) throw new Error("Old connection ended before announcing the new port");
            const change = next.value.change;

            if (change.case === "mobileRoutes" && change.value.addresses.includes(network.origins()[0]!))
              return change.value;
          }
        })();

        expect(routes.addresses).toEqual(changed.addresses.map((a) => a.origin));
        expect(routes.addresses).not.toEqual(original.addresses);
        phone.update(routes);

        // The existing stream gets its routes before the bounded drain closes its socket.
        try {
          while (!(await watch.next()).done) {
            /* drain old overview events */
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }

        expect(
          await eventually(async () => {
            try {
              await transport.probe(original.addresses[0]!, original.fingerprint);

              return false;
            } catch {
              return true;
            }
          }, Boolean),
        ).toBe(true);
        expect((await phone.api.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
        expect(phone.connection().lastAddress).toBe(network.origins()[0]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    15_000,
  );
});
