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
import { bffTarget } from "@canopy/domain/bff-target";

interface Connection {
  generation: number;
  url: string;
  token: string;
  desktop: ReturnType<typeof desktopGateway> | undefined;
  client?: Client<typeof ui.GatewayService>;
}

let connection: Connection | undefined;

/**
 * The gateway this BFF talks to. A server BFF reads its environment once; the desktop controller, which hosts the
 * bundled web in its own process, sets the target (bff-target.ts) and changes it on a mode or computer switch.
 */
function current(): Connection {
  const hosted = bffTarget();
  const generation = hosted?.generation ?? 0;

  if (connection?.generation === generation) return connection;
  const target = hosted?.target;
  const desktopToken = target ? target.desktopClient?.token : process.env["CANOPY_DESKTOP_CLIENT_TOKEN"];

  const desktopRoutes = target
    ? (target.desktopClient?.routes ?? "")
    : (process.env["CANOPY_DESKTOP_GATEWAY_ROUTES"] ?? "");

  connection = {
    generation,
    url: target?.gatewayUrl ?? GATEWAY_URL,
    token: target?.serviceToken ?? GATEWAY_SERVICE_TOKEN ?? "",
    desktop: desktopToken ? desktopGateway(desktopRoutes, desktopToken) : undefined,
  };

  return connection;
}

/** A non-secret namespace; backend addresses stay inside the BFF. */
export function clientPreferencesScope(): string {
  const { desktop, url } = current();

  return createHash("sha256")
    .update(desktop?.preferencesIdentity ?? url)
    .digest("hex");
}

export async function gatewayCompatibility(): Promise<GatewayCompatibility> {
  const { desktop } = current();

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
export function requireServiceToken(): string {
  const { desktop, token } = current();

  if (desktop) return "";

  if (!token) throw new Error("GATEWAY_SERVICE_TOKEN is not set (the gateway's CANOPY_UI_SERVICE_TOKEN)");

  return token;
}

export function gateway(): Client<typeof ui.GatewayService> {
  const token = requireServiceToken();
  const target = current();

  if (target.client) return target.client;
  const { desktop } = target;

  const client = createClient(
    ui.GatewayService,
    gatewayDeadlines(
      logGatewayFailures(
        desktop?.transport ??
          isolatedGatewayTransport(() =>
            createGrpcTransport({
              baseUrl: target.url,
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

  target.client = client;
  startBffDiagnostics(gateway);
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
