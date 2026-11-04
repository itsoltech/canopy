import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { error, fail, isActionFailure, isHttpError, type ActionFailure } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { GATEWAY_SERVICE_TOKEN, GATEWAY_URL } from "$app/env/private";
import { desktopGateway } from "./desktop-gateway.ts";

const desktop = process.env["CANOPY_DESKTOP_CLIENT_TOKEN"]
  ? desktopGateway(process.env["CANOPY_DESKTOP_GATEWAY_ROUTES"] ?? "", process.env["CANOPY_DESKTOP_CLIENT_TOKEN"])
  : undefined;

export const gatewayCompatibility = () =>
  desktop?.compatibility() ??
  Promise.resolve({
    state: "ready",
    message: "",
    methods: ui.GatewayService.methods.map((m) => m.name),
    gatewayVersion: "",
  });

/**
 * gRPC client of the gateway, used only on the SvelteKit server (BFF). The browser never sees the
 * gateway address or the service token (docs/ui-api.md).
 */
let client: Client<typeof ui.GatewayService> | undefined;

export function requireServiceToken(): string {
  if (desktop) return "";

  if (!GATEWAY_SERVICE_TOKEN)
    throw new Error("GATEWAY_SERVICE_TOKEN is not set (the gateway's CANOPY_UI_SERVICE_TOKEN)");

  return GATEWAY_SERVICE_TOKEN;
}

export function gateway(): Client<typeof ui.GatewayService> {
  const token = requireServiceToken();
  client ??= createClient(
    ui.GatewayService,
    desktop?.transport ??
      createGrpcTransport({
        baseUrl: GATEWAY_URL,
        defaultTimeoutMs: 3000,
        connectTimeoutMs: 3000,
        pingIntervalMs: 10_000,
        pingTimeoutMs: 3000,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${token}`);

            return next(request);
          },
        ],
      }),
  );

  return client;
}

/** Maps gateway errors to HTTP errors; internal details stay in the server log. */
export function failWith(cause: unknown): never {
  if (cause instanceof ConnectError) {
    switch (cause.code) {
      case Code.InvalidArgument:
        error(400, cause.rawMessage);
      case Code.NotFound:
        error(404, cause.rawMessage);
      case Code.PermissionDenied:
        error(403, cause.rawMessage);
      case Code.ResourceExhausted:
        error(429, cause.rawMessage);
      case Code.FailedPrecondition:
        error(409, cause.rawMessage);
      case Code.Unimplemented:
        error(426, "Update Canopy on your gateway to use this feature");
      case Code.Unauthenticated:
        error(401, "Desktop access is invalid or revoked. Pair this app again in gateway Settings → Devices");
      case Code.Unavailable:
        // Sent by the gateway (e.g. a worker is offline): the message is for the user. A transport
        // failure carries the Node error as `cause` and may name internal addresses: log it only.
        if (cause.cause === undefined) error(503, cause.rawMessage);
        console.error("gateway unreachable", cause);
        error(503, "The gateway is not available");
      default:
        break;
    }
  }

  console.error("gateway call failed", cause);
  error(502, "The gateway is not available");
}

export async function call<A>(run: (api: Client<typeof ui.GatewayService>) => Promise<A>): Promise<A> {
  try {
    return await run(gateway());
  } catch (cause) {
    failWith(cause);
  }
}

/**
 * Like `call`, for form actions: a rejected request (4xx) becomes `fail(status, { action, error })`, so the
 * form shows the reason next to its fields. Gateway outages still raise the error page.
 */
export async function attempt<A>(
  action: string,
  run: (api: Client<typeof ui.GatewayService>) => Promise<A>,
): Promise<A | FormFailure> {
  try {
    return await call(run);
  } catch (cause) {
    if (isHttpError(cause) && cause.status < 500) return fail(cause.status, { action, error: cause.body.message });
    throw cause;
  }
}

export type FormFailure = ActionFailure<{ action: string; error: string }>;

export const failed = <A>(result: A | FormFailure): result is FormFailure => isActionFailure(result);
