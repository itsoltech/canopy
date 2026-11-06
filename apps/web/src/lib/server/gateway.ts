import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { error, fail, isActionFailure, isHttpError, type ActionFailure } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { GATEWAY_SERVICE_TOKEN, GATEWAY_URL } from "$app/env/private";
import { desktopGateway, type GatewayCompatibility } from "./desktop-gateway.ts";
import { gatewayFailure } from "./gateway-errors.ts";

const desktop = process.env["CANOPY_DESKTOP_CLIENT_TOKEN"]
  ? desktopGateway(process.env["CANOPY_DESKTOP_GATEWAY_ROUTES"] ?? "", process.env["CANOPY_DESKTOP_CLIENT_TOKEN"])
  : undefined;

export async function gatewayCompatibility(): Promise<GatewayCompatibility> {
  if (desktop) return desktop.compatibility();

  try {
    const info = await gateway().getClientCapabilities({});

    return {
      state: "ready",
      message: "",
      methods: info.methods,
      gatewayVersion: info.gatewayVersion,
      gatewayRole: info.gatewayRole,
      linkedComputers: info.linkedComputers,
    };
  } catch (cause) {
    return {
      state: "unavailable",
      message: gatewayFailure(cause).message,
      methods: [],
      gatewayVersion: "",
      gatewayRole: "",
      linkedComputers: false,
    };
  }
}

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

/** Maps gateway errors to HTTP errors; only sanitised messages reach the response and log. */
export function failWith(cause: unknown): never {
  const failure = gatewayFailure(cause);

  if (failure.status >= 500) console.error("gateway call failed", failure);
  error(failure.status, { message: failure.message, ...("scope" in failure && { scope: failure.scope }) });
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
