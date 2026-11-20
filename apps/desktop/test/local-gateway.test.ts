import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { ui } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { startGrpcServer } from "@canopy/transport";
import { localGatewayClient, localGatewayTarget } from "../src/runtime/gateway-env.ts";

test("local service RPCs require the controller's certificate and its exact pin", async () => {
  const material = await localGatewayTarget(tempDir("canopy-gateway-tls-"), 0, "test-service-token");
  const other = await localGatewayTarget(tempDir("canopy-other-tls-"), 0, "unused-test-token");
  let calls = 0;

  const server = await startGrpcServer({
    tls: { cert: material.target.certificate, key: readFileSync(material.keyFile) },
    routes: (router) =>
      router.service(ui.GatewayService, {
        getClientCapabilities: (_request, context) => {
          expect(context.requestHeader.get("authorization") === "Bearer test-service-token").toBe(true);
          calls++;

          return {};
        },
      }),
  });

  const target = { ...material.target, gatewayUrl: server.url };

  try {
    if (process.platform !== "win32") expect(statSync(material.keyFile).mode & 0o777).toBe(0o600);
    await localGatewayClient(target).getClientCapabilities({});

    for (const pinned of [
      { certificate: other.target.certificate, fingerprint: other.target.fingerprint },
      { certificate: target.certificate, fingerprint: other.target.fingerprint },
    ])
      await expect(localGatewayClient({ ...target, ...pinned }).getClientCapabilities({})).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    await server.close(0);
  }
});
