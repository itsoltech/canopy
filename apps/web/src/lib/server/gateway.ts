import { createClient, type Client } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { error, fail, isActionFailure, isHttpError, type ActionFailure } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { GATEWAY_SERVICE_TOKEN, GATEWAY_URL } from "$app/env/private";
import { desktopGateway, type GatewayCompatibility } from "./desktop-gateway.ts";
import { desktopWebOrigin } from "./desktop-origin.ts";
import { gatewayFailure } from "./gateway-errors.ts";
import { logGatewayFailures } from "./gateway-logging.ts";
import { isolatedGatewayTransport } from "./gateway-transport.ts";
import { gatewayDeadlines } from "./gateway-deadlines.ts";
import { startBffDiagnostics } from "./diagnostics.ts";
import { startBffLogs } from "./log-source.ts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { WEB_VERSION_HEADER } from "@canopy/domain/release/web-version";
import { compareVersions } from "@canopy/updater/release";

const desktop = process.env["CANOPY_DESKTOP_CLIENT_TOKEN"]
  ? desktopGateway(process.env["CANOPY_DESKTOP_GATEWAY_ROUTES"] ?? "", process.env["CANOPY_DESKTOP_CLIENT_TOKEN"])
  : undefined;

/** A non-secret namespace; backend addresses stay inside the BFF. */
export function clientPreferencesScope(): string {
  return createHash("sha256")
    .update(desktop?.preferencesIdentity ?? GATEWAY_URL)
    .digest("hex");
}

export async function gatewayCompatibility(): Promise<GatewayCompatibility> {
  if (desktop) return desktop.compatibility();

  try {
    const info = await gateway().getClientCapabilities({});

    return {
      state: "ready",
      webLag: webLag(info.gatewayVersion),
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
 * This web app against its gateway (server BFFs only; the desktop pairs its own versions): "older", "newer" or "".
 * A web run from source (0.0.0-dev) or an unparsable version never warns.
 */
function webLag(gatewayVersion: string): "older" | "newer" | "" {
  if (desktopWebOrigin() || !gatewayVersion || [CANOPY_VERSION, gatewayVersion].includes("0.0.0-dev")) return "";

  try {
    const order = compareVersions(CANOPY_VERSION, gatewayVersion);

    return order < 0 ? "older" : order > 0 ? "newer" : "";
  } catch {
    return "";
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
    gatewayDeadlines(
      logGatewayFailures(
        desktop?.transport ??
          isolatedGatewayTransport(() =>
            createGrpcTransport({
              baseUrl: GATEWAY_URL,
              defaultTimeoutMs: 3000,
              connectTimeoutMs: 3000,
              pingIntervalMs: 10_000,
              pingTimeoutMs: 3000,
              interceptors: [
                (next) => (request) => {
                  request.header.set("authorization", `Bearer ${token}`);
                  request.header.set(WEB_VERSION_HEADER, CANOPY_VERSION);

                  return next(request);
                },
              ],
            }),
          ),
      ),
    ),
  );

  startBffDiagnostics(client);
  startBffLogs(client);

  return client;
}

/** Maps gateway errors to HTTP errors; only sanitised messages reach the response and log. */
export function failWith(cause: unknown): never {
  const failure = gatewayFailure(cause);

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
