import { describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { createClient } from "@connectrpc/connect";
import { startGrpcServer, routedPinnedTransport } from "@canopy/transport";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener } from "../../apps/gateway/src/network/listener.ts";
import { desktopGateway, type GatewayCompatibility } from "../../apps/web/src/lib/server/desktop-gateway.ts";
import { failure } from "./support/gateway.ts";

describe("bundled desktop BFF protocol negotiation over real TLS", () => {
  const methods = ui.GatewayService.methods.map((m) => m.name);

  for (const scenario of [
    {
      label: "same protocol, different build",
      minProtocol: 1,
      maxProtocol: 1,
      gatewayVersion: "0.0.1",
      state: "ready",
    },
    { label: "new build, same protocol", minProtocol: 1, maxProtocol: 1, gatewayVersion: "99.0.0", state: "ready" },
    {
      label: "gateway needs a newer client",
      minProtocol: 2,
      maxProtocol: 2,
      gatewayVersion: "99.0.0",
      state: "app-update",
    },
    {
      label: "gateway lacks protocol negotiation",
      minProtocol: 0,
      maxProtocol: 0,
      gatewayVersion: "0.0.1",
      state: "gateway-update",
    },
  ] satisfies {
    label: string;
    minProtocol: number;
    maxProtocol: number;
    gatewayVersion: string;
    state: GatewayCompatibility["state"];
  }[]) {
    test(scenario.label, async () => {
      const identity = await generateIdentity();
      let calls = 0;

      const server = await startGrpcServer({
        tls: { cert: identity.certificate, key: identity.privateKey },
        routes: (router) =>
          router.service(ui.GatewayService, {
            getClientCapabilities: () =>
              create(ui.ClientCapabilitiesSchema, { ...scenario, methods, gatewayName: "Test gateway" }),
            getOverview: () => {
              calls++;

              return {};
            },
          }),
      });

      try {
        const bff = desktopGateway(
          toJsonString(
            ui.MobileRoutesSchema,
            create(ui.MobileRoutesSchema, { fingerprint: identity.fingerprint, addresses: [server.url] }),
          ),
          "test-desktop-token",
        );

        const status = await bff.compatibility();
        expect(status.state).toBe(scenario.state);

        if (scenario.state === "ready") {
          expect(status.message).toBe("");
          await createClient(ui.GatewayService, bff.transport).getOverview({});
          expect(calls).toBe(1);
        } else {
          expect(await failure(createClient(ui.GatewayService, bff.transport).getOverview({}))).toContain("Update");
          expect(calls).toBe(0);
        }
      } finally {
        await server.close(0);
      }
    });
  }

  test("missing handshake RPC gives an update state; missing optional RPC keeps core screens usable", async () => {
    const identity = await generateIdentity();

    for (const handshake of [false, true]) {
      const server = await startGrpcServer({
        tls: { cert: identity.certificate, key: identity.privateKey },
        routes: (router) =>
          router.service(ui.GatewayService, {
            ...(handshake && {
              getClientCapabilities: () => ({
                minProtocol: 1,
                maxProtocol: 1,
                methods: methods.filter((m) => m !== "ListBots"),
              }),
            }),
            getOverview: () => ({}),
            getSettings: () => ({}),
          }),
      });

      try {
        const bff = desktopGateway(
          JSON.stringify({ fingerprint: identity.fingerprint, addresses: [server.url] }),
          "test-desktop-token",
        );

        const client = createClient(ui.GatewayService, bff.transport);
        expect((await bff.compatibility()).state).toBe(handshake ? "ready" : "gateway-update");

        if (handshake) {
          await client.getOverview({});
          await client.getSettings({});
          expect(await failure(client.listBots({}))).toContain("Update Canopy on your gateway");
          // Descriptor says available, old gateway nevertheless has no implementation.
          expect(await failure(client.getWorkerSetup({}))).toContain("Update Canopy on your gateway");
        }
      } finally {
        await server.close(0);
      }
    }
  });

  test("a mutation whose response is lost is sent only once, even with another verified route", async () => {
    const identity = await generateIdentity();
    let requests = 0;

    const listener = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity,
      route: () => (request) => {
        requests++;
        request.socket.destroy();
      },
    });

    try {
      const transport = routedPinnedTransport(
        {
          fingerprint: identity.fingerprint,
          addresses: [`https://127.0.0.1:${listener.port}`, `https://localhost:${listener.port}`],
        },
        "test-desktop-token",
      ).transport;

      expect(
        await failure(createClient(ui.GatewayService, transport).createProject({ name: "Once" }, { timeoutMs: 3000 })),
      ).not.toBe("");
      expect(requests).toBe(1);
    } finally {
      await listener.close();
    }
  });
});
