import { createClient, Code, ConnectError, type Transport } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { fromJsonString } from "@bufbuild/protobuf";
import { Match } from "effect";
import { routedPinnedTransport } from "@canopy/transport";
import { DESKTOP_CLIENT_PROTOCOL, MIN_DESKTOP_CLIENT_PROTOCOL } from "@canopy/domain/release/protocol";
import { gatewayFailure } from "./gateway-errors.ts";
import { isolatedGatewayTransport } from "./gateway-transport.ts";

/** How long a successful negotiation is reused without a failing call (ms). */
const READY_MS = 60_000;
const RENEGOTIATE = new Set([Code.Unavailable, Code.Unimplemented, Code.Unauthenticated]);

export interface GatewayCompatibility {
  state: "ready" | "gateway-update" | "app-update" | "unavailable" | "pairing";
  message: string;
  methods: string[];
  gatewayVersion: string;
  linkedComputers: boolean;
  gatewayRole: string;
}

/** Server-only bearer, supplied by Electron's controller. No service token from the remote server. */
export function desktopGateway(routesJson: string, token: string) {
  const routes = fromJsonString(ui.MobileRoutesSchema, routesJson, { ignoreUnknownFields: true });
  const pools: ReturnType<typeof routedPinnedTransport>[] = [];

  const transport = isolatedGatewayTransport(() => {
    const pool = routedPinnedTransport(routes, token);
    pools.push(pool);

    return pool.transport;
  });

  const raw = createClient(ui.GatewayService, transport);

  let snapshot: GatewayCompatibility = {
    state: "unavailable",
    message: "Could not reach the gateway. Check that it is running, then retry.",
    methods: [],
    gatewayVersion: "",
    linkedComputers: false,
    gatewayRole: "",
  };

  let expires = 0;
  let pending: Promise<GatewayCompatibility> | undefined;
  let failureCode: Code | undefined;

  async function refresh(): Promise<GatewayCompatibility> {
    try {
      const info = await raw.getClientCapabilities({}, { timeoutMs: 2500 });
      failureCode = undefined;

      if (info.routes) for (const pool of pools) pool.update(info.routes);
      const name = info.gatewayName || "your gateway";
      const core = ["GetOverview", "ListThreads", "GetThread", "GetSettings", "WatchOverview", "WatchThread"];

      const state =
        info.minProtocol > DESKTOP_CLIENT_PROTOCOL
          ? "app-update"
          : info.maxProtocol < MIN_DESKTOP_CLIENT_PROTOCOL ||
              info.minProtocol === 0 ||
              info.maxProtocol < info.minProtocol ||
              core.some((method) => !info.methods.includes(method))
            ? "gateway-update"
            : "ready";

      snapshot = {
        state,
        gatewayVersion: info.gatewayVersion,
        methods: info.methods,
        linkedComputers: info.linkedComputers,
        gatewayRole: info.gatewayRole,
        message: Match.value(state).pipe(
          Match.when("app-update", () => "Update this app to connect to this gateway"),
          Match.when("gateway-update", () => `Update Canopy on ${name} to use this app`),
          Match.orElse(() => ""),
        ),
      };
    } catch (cause) {
      const code = cause instanceof ConnectError ? cause.code : undefined;
      failureCode = code ?? Code.Internal;
      snapshot = {
        state:
          code === Code.Unimplemented ? "gateway-update" : code === Code.Unauthenticated ? "pairing" : "unavailable",
        message:
          code === Code.Unimplemented
            ? "Update Canopy on your gateway to use this app"
            : code === Code.Unauthenticated
              ? "Desktop access was revoked. Pair this app again in gateway Settings → Devices"
              : gatewayFailure(cause).message,
        methods: [],
        gatewayVersion: "",
        linkedComputers: false,
        gatewayRole: "",
      };
    }

    // A negotiation holds for the connection: calls that fail as unavailable, unimplemented or
    // unauthenticated renegotiate at once, so a restart, upgrade or revocation is noticed without polling.
    expires = Date.now() + (snapshot.state === "ready" ? READY_MS : 1000);

    return snapshot;
  }

  const compatibility = () =>
    Date.now() < expires
      ? Promise.resolve(snapshot)
      : (pending ??= refresh().finally(() => {
          pending = undefined;
        }));

  async function requireMethod(name: string) {
    const info = await compatibility();

    if (info.state !== "ready")
      throw new ConnectError(
        info.message,
        failureCode ??
          Match.value(info.state).pipe(
            Match.when("unavailable", () => Code.Unavailable),
            Match.when("pairing", () => Code.Unauthenticated),
            Match.orElse(() => Code.FailedPrecondition),
          ),
      );

    if (!info.methods.includes(name))
      throw new ConnectError("Update Canopy on your gateway to use this feature", Code.Unimplemented);
  }

  const unary: Transport["unary"] = async (...args) => {
    await requireMethod(args[0].name);

    try {
      return await transport.unary(...args);
    } catch (cause) {
      if (cause instanceof ConnectError && RENEGOTIATE.has(cause.code)) expires = 0;

      if (cause instanceof ConnectError && cause.code === Code.Unimplemented)
        throw new ConnectError("Update Canopy on your gateway to use this feature", Code.Unimplemented);

      throw cause;
    }
  };

  const stream: Transport["stream"] = async (...args) => {
    await requireMethod(args[0].name);

    try {
      return await transport.stream(...args);
    } catch (cause) {
      if (cause instanceof ConnectError && RENEGOTIATE.has(cause.code)) expires = 0;
      throw cause;
    }
  };

  return { transport: { unary, stream }, compatibility };
}
