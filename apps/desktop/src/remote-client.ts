import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { fromJsonString, toJsonString, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { pinnedOrigins, routedPinnedTransport, type PinnedRoutes } from "@canopy/transport";
import type { DesktopConfiguration } from "@canopy/ui/desktop";

export type RemoteConfiguration = Extract<DesktopConfiguration, { mode: "remote" }>;

export interface DesktopClientCredential {
  token: string;
  deviceId: string;
  fingerprint: string;
  addresses: string[];
}

export const remoteWorkerDirectory = (directory: string, config: RemoteConfiguration) =>
  join(
    directory,
    "remote-workers",
    createHash("sha256")
      .update(config.workerGatewayUrl ?? config.gatewayUrl)
      .digest("hex")
      .slice(0, 24),
  );

export function desktopGatewayRoutes<T extends PinnedRoutes>(routes: T, gatewayUrl?: string): T {
  // A legacy configuration can still carry the worker's cleartext address.
  if (!gatewayUrl || new URL(gatewayUrl).protocol !== "https:") return routes;

  const addresses = [...new Set([...pinnedOrigins([gatewayUrl]), ...routes.addresses])].slice(0, 32);

  return { ...routes, addresses };
}

/** Parse protobuf JSON at the vault boundary; never allow an unpinned credential. */
export function readDesktopCredential(text: string): DesktopClientCredential {
  let value: ui.ExchangeMobilePairingResponse;

  try {
    value = fromJsonString(ui.ExchangeMobilePairingResponseSchema, text, { ignoreUnknownFields: true });
  } catch {
    throw new Error("Pair this app again in gateway Settings → Devices");
  }

  if (
    !/^canopy_desktop_[A-Za-z0-9_-]{43}$/.test(value.deviceToken) ||
    !value.device?.id ||
    value.device.clientKind !== "desktop" ||
    !/^[a-f0-9]{64}$/i.test(value.routes?.fingerprint ?? "")
  )
    throw new Error("Pair this app again in gateway Settings → Devices");

  return {
    token: value.deviceToken,
    deviceId: value.device.id,
    fingerprint: value.routes!.fingerprint.toLowerCase(),
    addresses: pinnedOrigins(value.routes!.addresses),
  };
}

export function credentialMessage(client: DesktopClientCredential) {
  return create(ui.ExchangeMobilePairingResponseSchema, {
    deviceToken: client.token,
    device: { id: client.deviceId, clientKind: "desktop" },
    routes: { fingerprint: client.fingerprint, addresses: client.addresses },
  });
}

export function readDesktopInvitation(invitation: string) {
  // The copy action in Settings emits protobuf JSON: code + routes, no service token.
  let input: ui.CreateMobilePairingResponse;

  try {
    input = fromJsonString(ui.CreateMobilePairingResponseSchema, invitation, { ignoreUnknownFields: true });
  } catch {
    throw new Error("Paste a desktop invitation from gateway Settings → Devices");
  }

  if (input.pairing?.clientKind !== "desktop" || !input.routes)
    throw new Error("Create a desktop pairing code in gateway Settings → Devices");

  return { code: input.code, routes: input.routes };
}

export async function pairDesktop(invitation: string, gatewayUrl?: string) {
  const input = readDesktopInvitation(invitation);
  const routed = routedPinnedTransport(desktopGatewayRoutes(input.routes, gatewayUrl));
  const api = createClient(ui.DesktopPairingService, routed.transport);

  const result = await api
    .exchangeDesktopPairing({ code: input.code, name: hostname(), platform: process.platform }, { timeoutMs: 5000 })
    .catch((cause: unknown) => {
      if (cause instanceof ConnectError && cause.code === Code.Unimplemented)
        throw new Error("Update Canopy on the gateway, then create a desktop invitation in Settings → Devices");

      if (cause instanceof ConnectError) throw new Error(cause.rawMessage);
      throw new Error("Could not pair securely. Check the gateway address and certificate fingerprint.");
    });

  const credential = readDesktopCredential(toJsonString(ui.ExchangeMobilePairingResponseSchema, result));

  if (credential.fingerprint !== input.routes.fingerprint.toLowerCase())
    throw new Error("Could not verify the gateway. Copy a new desktop invitation from Settings → Devices.");

  return { ...credential, address: routed.connection().lastAddress };
}
