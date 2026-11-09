import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { mobileGuard, mobileIdentity } from "../core/mobile-devices.ts";
import type { UiHandlers } from "./ui-service.ts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { DESKTOP_CLIENT_PROTOCOL, MIN_DESKTOP_CLIENT_PROTOCOL } from "@canopy/domain/release/protocol";

export function mobileHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getMobileDevices"
  | "createMobilePairing"
  | "createDesktopPairing"
  | "getClientCapabilities"
  | "revokeMobilePairing"
  | "revokeMobileDevice"
  | "unpairMobileDevice"
> {
  return {
    getClientCapabilities: async () =>
      create(ui.ClientCapabilitiesSchema, {
        gatewayVersion: CANOPY_VERSION,
        gatewayRole: core.role,
        linkedComputers: core.role === "desktop",
        // The identity's name only: a full computers snapshot (routes, peers, notices) is not needed here.
        gatewayName: core.computers?.hello().name || "your gateway",
        minProtocol: MIN_DESKTOP_CLIENT_PROTOCOL,
        maxProtocol: DESKTOP_CLIENT_PROTOCOL,
        methods: ui.GatewayService.methods.map((method) => method.name),
        routes: core.mobile.networkRoutes(),
      }),

    createDesktopPairing: () => mobileGuard(() => core.mobile.create("desktop")),
    getMobileDevices: () => mobileGuard(() => core.mobile.list()),

    createMobilePairing: () => mobileGuard(() => core.mobile.create()),

    revokeMobilePairing: (r) =>
      mobileGuard(async () => {
        await core.mobile.revoke(r.id, "pairing");

        return create(ui.MobileOperationResponseSchema);
      }),

    revokeMobileDevice: (r) =>
      mobileGuard(async () => {
        await core.mobile.revoke(r.id, "device");

        return create(ui.MobileOperationResponseSchema);
      }),

    unpairMobileDevice: (_r, context) =>
      mobileGuard(async () => {
        const identity = context.values.get(mobileIdentity);

        if (!identity) throw new ConnectError("Device token required", Code.Unauthenticated);
        await core.mobile.revoke(identity.deviceId, "device");

        return create(ui.MobileOperationResponseSchema);
      }),
  };
}
