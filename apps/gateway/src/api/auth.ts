import { timingSafeEqual } from "node:crypto";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { mobileIdentity, type MobileDevices } from "../core/mobile-devices.ts";

/**
 * The web BFF uses a service token. Paired devices use their own revocable bearer
 * token, scoped to the single owner. Pairing administration stays BFF-only.
 * WorkerLinkService authenticates workers itself and is not affected.
 */
export function serviceTokenAuth(token: string, mobile?: MobileDevices): Interceptor {
  if (token.length < 32) throw new Error("UI service token must have at least 32 characters");
  const expected = Buffer.from(token);
  return (next) => async (request) => {
    if (request.service.typeName === ui.GatewayService.typeName) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.header.get("authorization") ?? "")?.[1] ?? "";
      const presented = Buffer.from(bearer);
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) return next(request);
      const identity = await mobile?.authenticate(bearer);
      if (!identity || !mobile) throw new ConnectError("Invalid or revoked device token", Code.Unauthenticated);
      if (["GetMobileDevices", "CreateMobilePairing", "RevokeMobilePairing", "RevokeMobileDevice", "ManageUpdates", "WorkerSsh", "FetchWorkerInstall", "GetComputers", "CreateComputerPairing", "LinkComputer", "ManageComputer", "PreviewMove", "StartMove", "GetMoves"].includes(request.method.name)) {
        throw new ConnectError("Manage mobile devices in web Settings", Code.PermissionDenied);
      }
      request.contextValues.set(mobileIdentity, identity);
      const controller = new AbortController();
      const release = mobile.track(identity.deviceId, controller);
      try {
        // Register before rechecking: a concurrent revoke cannot leave an authenticated stream open.
        if (!await mobile.authenticate(bearer)) throw new ConnectError("Device revoked", Code.Unauthenticated);
        const response = await next({ ...request, signal: AbortSignal.any([request.signal, controller.signal]) });
        if (!response.stream) { release(); return response; }
        return { ...response, message: (async function* () {
          try { yield* response.message; } finally { release(); }
        })() };
      } catch (error) { release(); throw error; }
    }
    return next(request);
  };
}
