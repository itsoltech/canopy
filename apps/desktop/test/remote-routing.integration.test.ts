import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { bffTarget } from "@canopy/domain/bff-target";
import { startGrpcServer } from "@canopy/transport";
import { tempDir } from "@canopy/testing";
import { generateIdentity } from "../../gateway/src/computers/identity.ts";
import { desktopGateway } from "../../web/src/lib/server/desktop-gateway.ts";
import { pairDesktop, remoteWorkerDirectory } from "../src/remote-client.ts";
import { DesktopRuntime } from "../src/runtime/runtime.ts";

const token = `canopy_desktop_${"a".repeat(43)}`;
const deviceId = "desktop-routing-device";

function bff() {
  const target = bffTarget()?.target;

  if (target?.mode !== "remote") throw new Error("Expected a remote BFF target");
  const client = desktopGateway(target.desktopClient.routes, target.desktopClient.token);

  return createClient(ui.GatewayService, client.transport);
}

test("a changed BFF address recovers with the paired credential and keeps the worker profile across restart", async () => {
  const directory = tempDir("canopy-desktop-rerouting-");
  const web = join(directory, "web.js");
  const worker = join(directory, "worker.js");
  writeFileSync(web, "export const handler = (_request, response) => response.end();");
  writeFileSync(worker, "setInterval(() => {}, 60_000);");

  const launch = () =>
    new DesktopRuntime(
      directory,
      { bun: process.execPath, web, worker, gateway: "unused", postgres: "unused" },
      {
        secretsKey: "fixture",
        serviceToken: "fixture",
        databasePassword: "fixture",
        runtimeDatabasePassword: "fixture",
      },
    );

  const wrongIdentity = await generateIdentity();
  const identity = await generateIdentity();
  let wrongRequests = 0;

  const stale = await startGrpcServer({
    tls: { cert: wrongIdentity.certificate, key: wrongIdentity.privateKey },
    routes: (router) =>
      router.service(ui.GatewayService, {
        getClientCapabilities() {
          wrongRequests++;

          return {};
        },
      }),
  });

  const gateway = await startGrpcServer({
    tls: { cert: identity.certificate, key: identity.privateKey },
    routes: (router) =>
      router.service(ui.GatewayService, {
        getClientCapabilities: () => ({
          minProtocol: 1,
          maxProtocol: 1,
          methods: ui.GatewayService.methods.map((method) => method.name),
          routes: { fingerprint: identity.fingerprint, addresses: [stale.url] },
        }),
        getOverview(_request, context) {
          if (context.requestHeader.get("authorization") !== `Bearer ${token}`)
            throw new ConnectError("Expected the existing Desktop credential", Code.Unauthenticated);

          return { workers: [{ id: workerId }] };
        },
      }),
  });

  const workerId = Bun.randomUUIDv7();
  const original = { mode: "remote" as const, gatewayUrl: stale.url };
  const workerDirectory = remoteWorkerDirectory(directory, original);
  const workerFile = join(workerDirectory, "worker.json");
  const workerConfig = JSON.stringify({ worker_id: workerId, gateway_url: "http://127.0.0.1:1" });
  mkdirSync(workerDirectory, { recursive: true });
  writeFileSync(workerFile, workerConfig);
  const client = { token, deviceId, fingerprint: identity.fingerprint, addresses: [stale.url] };
  let desktop = launch();

  try {
    await desktop.initialize(false);
    await desktop.configure(original, client);
    await expect(bff().getOverview({})).rejects.toThrow("pinned TLS connection");
    expect(desktop.status.workerId).toBe(workerId);

    await desktop.configure({ mode: "remote", gatewayUrl: gateway.url }, client);
    expect((await bff().getOverview({})).workers[0]?.id).toBe(workerId);
    expect(desktop.status.configuration).toEqual({
      mode: "remote",
      gatewayUrl: gateway.url,
      workerGatewayUrl: stale.url,
    });
    expect(desktop.status.workerId).toBe(workerId);

    await desktop.stop();
    desktop = launch();
    await desktop.initialize(false);
    await desktop.restore(client);
    expect((await bff().getOverview({})).workers[0]?.id).toBe(workerId);
    expect(desktop.status.workerId).toBe(workerId);
    expect(readFileSync(workerFile, "utf8")).toBe(workerConfig);
    expect(wrongRequests).toBe(0);
  } finally {
    await desktop.stop();
    await Promise.all([gateway.close(0), stale.close(0)]);
  }
}, 15_000);

test("a pairing invitation can use an entered route after verifying the invitation pin", async () => {
  const identity = await generateIdentity();
  let exchanges = 0;

  const gateway = await startGrpcServer({
    tls: { cert: identity.certificate, key: identity.privateKey },
    routes: (router) =>
      router.service(ui.DesktopPairingService, {
        exchangeDesktopPairing(request) {
          exchanges++;
          expect(request.code).toBe("routing-test");

          return {
            device: { id: deviceId, clientKind: "desktop" },
            deviceToken: token,
            routes: { fingerprint: identity.fingerprint, addresses: ["https://127.0.0.1:1"] },
          };
        },
      }),
  });

  const invitation = (fingerprint: string) =>
    toJsonString(
      ui.CreateMobilePairingResponseSchema,
      create(ui.CreateMobilePairingResponseSchema, {
        code: "routing-test",
        pairing: { clientKind: "desktop" },
        routes: { fingerprint, addresses: ["https://127.0.0.1:1"] },
      }),
    );

  try {
    await expect(pairDesktop(invitation("0".repeat(64)), gateway.url)).rejects.toThrow("pinned TLS connection");
    expect(exchanges).toBe(0);
    const credential = await pairDesktop(invitation(identity.fingerprint), gateway.url);
    expect(credential).toMatchObject({
      deviceId,
      fingerprint: identity.fingerprint,
    });
    expect(exchanges).toBe(1);
  } finally {
    await gateway.close(0);
  }
});
