import { WEB_VERSION_HEADER } from "@canopy/domain/release/web-version";
import { timingSafeEqual } from "node:crypto";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { mobileIdentity, type MobileDevices } from "../core/mobile-devices.ts";

/** Authenticated BFF service token on the process listener, outside the public Network access listener. */
export const serviceIdentity = createContextKey(false);

/**
 * The web BFF uses a service token. Paired devices use their own revocable bearer
 * token, scoped to the single owner. Phones and desktop clients have the same
 * owner UI scope; each core service enforces ownership independently.
 * WorkerLinkService authenticates workers itself and is not affected.
 */
/** `web` hears the version every service-token caller (a web BFF) reports, "" when it sends none. */
export function serviceTokenAuth(
  token: string,
  mobile?: MobileDevices,
  web?: (webVersion: string) => void,
  listener: "process" | "network" = "process",
): Interceptor {
  if (token.length < 32) throw new Error("UI service token must have at least 32 characters");
  const expected = Buffer.from(token);

  return (next) => async (request) => {
    if (request.service.typeName === ui.GatewayService.typeName) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.header.get("authorization") ?? "")?.[1] ?? "";
      const presented = Buffer.from(bearer);

      if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
        request.contextValues.set(serviceIdentity, listener === "process");
        web?.(request.header.get(WEB_VERSION_HEADER) ?? "");

        return next(request);
      }

      if (!mobile) throw new ConnectError("Invalid UI service token", Code.Unauthenticated);
      const identity = await mobile.authenticate(bearer);

      if (!identity) throw new ConnectError("Invalid or revoked device token", Code.Unauthenticated);

      request.contextValues.set(mobileIdentity, identity);
      const controller = new AbortController();
      const release = mobile.track(identity.deviceId, controller);

      try {
        // Register before rechecking: a concurrent revoke cannot leave an authenticated stream open.
        if (!(await mobile.authenticate(bearer))) throw new ConnectError("Device revoked", Code.Unauthenticated);
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const response = await next({ ...request, signal });

        if (!response.stream) {
          // This RPC revokes its own token and returns only an empty acknowledgement after success.
          if (request.method.name !== "UnpairMobileDevice") controller.signal.throwIfAborted();
          release();

          return response;
        }

        return {
          ...response,
          message: (async function* () {
            try {
              for await (const message of response.message) {
                controller.signal.throwIfAborted();
                yield message;
              }

              controller.signal.throwIfAborted();
            } finally {
              release();
            }
          })(),
        };
      } catch (error) {
        release();
        throw error;
      }
    }

    return next(request);
  };
}
