import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { createGrpcClientTransport } from "@canopy/transport";
import type { LocalBffTarget } from "@canopy/domain/bff-target";
import "reflect-metadata";
import { writePrivateFile } from "./private-file.ts";

/** New identity for each local configuration. Only the supervised gateway needs the private key on restart. */
export async function localGatewayTarget(directory: string, port: number, serviceToken: string) {
  const { generateIdentity } = await import("../../../gateway/src/computers/identity.ts");
  const { certificate, fingerprint, privateKey } = await generateIdentity();
  const tls = join(directory, "local-gateway-tls");
  mkdirSync(tls, { recursive: true, mode: 0o700 });

  if (process.platform !== "win32") chmodSync(tls, 0o700);
  const certFile = join(tls, "certificate.pem");
  const keyFile = join(tls, "key.pem");
  writePrivateFile(certFile, certificate);
  writePrivateFile(keyFile, privateKey);

  const target: LocalBffTarget = {
    mode: "local",
    gatewayUrl: `https://127.0.0.1:${port}`,
    certificate,
    fingerprint,
    serviceToken,
  };

  return { target, certFile, keyFile };
}

export function localGatewayClient(target: LocalBffTarget) {
  return createClient(
    ui.GatewayService,
    createGrpcClientTransport({
      baseUrl: target.gatewayUrl,
      ca: target.certificate,
      fingerprint: target.fingerprint,
      connectTimeoutMs: 1000,
      defaultTimeoutMs: 3000,
      interceptors: [
        (next) => (request) => {
          request.header.set("authorization", `Bearer ${target.serviceToken}`);

          return next(request);
        },
      ],
    }),
  );
}

export function localGatewayEnvironment(
  base: NodeJS.ProcessEnv,
  secrets: { secretsKey: string; serviceToken: string },
  options: { databaseUrl: string; port: number; webOrigin: string; certFile: string; keyFile: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    CANOPY_DATABASE_URL: options.databaseUrl,
    CANOPY_MIGRATE: "0",
    CANOPY_SECRETS_KEY: secrets.secretsKey,
    CANOPY_UI_SERVICE_TOKEN: secrets.serviceToken,
    CANOPY_GATEWAY_ROLE: "desktop",
    CANOPY_WEB_ORIGIN: options.webOrigin,
    CANOPY_HOST: "127.0.0.1",
    CANOPY_PORT: String(options.port),
    CANOPY_TLS_CERT: options.certFile,
    CANOPY_TLS_KEY: options.keyFile,
  };
}
