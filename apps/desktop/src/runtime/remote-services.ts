import {
  desktopGatewayRoutes,
  remoteWorkerDirectory,
  type DesktopClientCredential,
  type RemoteConfiguration,
} from "../remote-client.ts";
import { remoteEnrollment } from "./worker-runtime.ts";
import type { Logs } from "./log.ts";
import type { DesktopWeb } from "./web.ts";

export async function startRemoteServices(options: {
  config: RemoteConfiguration;
  credential?: DesktopClientCredential | undefined;
  directory: string;
  logs: Logs;
  origin: string;
  web: DesktopWeb;
}) {
  const { config, credential, directory, logs, origin, web } = options;
  const workerDirectory = remoteWorkerDirectory(directory, config);
  const client = credential && desktopGatewayRoutes(credential, config.gatewayUrl);
  const gatewayUrl = client?.addresses[0] ?? config.gatewayUrl;

  if (client) {
    logs.protect(client.token);
    await web.start(origin, {
      mode: "remote",
      gatewayUrl,
      desktopClient: {
        token: client.token,
        routes: JSON.stringify({ fingerprint: client.fingerprint, addresses: client.addresses }),
      },
    });
  }

  const enrollment =
    client && !config.enrollmentToken ? await remoteEnrollment(client, workerDirectory, logs) : undefined;

  return {
    client,
    gatewayUrl,
    workerDirectory,
    token: config.enrollmentToken ?? enrollment?.token,
    workerAddress: config.enrollmentToken ? config.gatewayUrl : enrollment?.gatewayUrl || gatewayUrl,
  };
}
