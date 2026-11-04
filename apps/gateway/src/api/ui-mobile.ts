import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { mobileGuard, mobileIdentity } from "../core/mobile-devices.ts";
import type { UiHandlers } from "./ui-service.ts";

export function mobileHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  "getMobileDevices" | "createMobilePairing" | "revokeMobilePairing" | "revokeMobileDevice" | "unpairMobileDevice"
> {
  return {
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
