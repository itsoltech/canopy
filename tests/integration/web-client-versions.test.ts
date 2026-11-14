import { afterEach, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { WEB_MIGRATION_DOCS, WEB_VERSION_HEADER } from "@canopy/domain/release/web-version";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { startGrpcServer } from "@canopy/transport";
import { serviceTokenAuth } from "../../apps/gateway/src/api/auth.ts";
import { WebClientVersions } from "../../apps/gateway/src/web/clients.ts";

/**
 * A web BFF of another version than its gateway (a retired canopy-web container left in an old Compose file)
 * is noticed by the gateway over the real gRPC interceptor: a warning in the log and a line in App updates.
 */
const SERVICE_TOKEN = "web-client-versions-token-0123456789abcdef";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gateway(embedded: boolean) {
  const logs: string[] = [];
  const clients = new WebClientVersions("2.0.0", embedded, (message) => logs.push(message));

  const server = await startGrpcServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        getClientCapabilities: () => create(ui.ClientCapabilitiesSchema, { gatewayVersion: "2.0.0" }),
      }),
    host: "127.0.0.1",
    port: 0,
    interceptors: [serviceTokenAuth(SERVICE_TOKEN, undefined, (version) => clients.seen(version))],
  });

  cleanups.push(() => server.close());

  /** A BFF that sends `version` (undefined: one from before the header). */
  const bff = (version: string | undefined) =>
    createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: server.url,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            if (version !== undefined) request.header.set(WEB_VERSION_HEADER, version);

            return next(request);
          },
        ],
      }),
    );

  return { clients, logs, bff };
}

test("the embedded web of the same version is quiet", async () => {
  const g = await gateway(true);
  await g.bff("2.0.0").getClientCapabilities({});
  expect(g.clients.notice).toBe("");
  expect(g.logs).toEqual([]);
});

test("a BFF from before the version header is a separate, older web: warned once, shown in App updates", async () => {
  const g = await gateway(true);

  for (let i = 0; i < 3; i++) await g.bff(undefined).getClientCapabilities({});
  expect(g.logs).toHaveLength(1);
  expect(g.logs[0]).toContain("A web app older than the gateway (before 2.0.0) is connected.");
  expect(g.clients.notice).toBe(
    `A web app older than the gateway (before 2.0.0) is connected. Remove the separate web service: the gateway serves the web now. ${WEB_MIGRATION_DOCS}`,
  );
});

test("a headless gateway asks for the matching web version instead", async () => {
  const g = await gateway(false);
  await g.bff("1.9.0").getClientCapabilities({});
  expect(g.clients.notice).toContain(
    "A web app older than the gateway (1.9.0) is connected. Run the web app of version 2.0.0.",
  );
  await g.bff("2.1.0").getClientCapabilities({});
  expect(g.logs.some((line) => line.includes("A web app of another version (2.1.0) is connected."))).toBe(true);
});
