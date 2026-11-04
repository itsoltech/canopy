import { createClient, Code, ConnectError, type Transport } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { fromJsonString } from "@bufbuild/protobuf";
import { Match } from "effect";
import { routedPinnedTransport } from "@canopy/transport";
import { DESKTOP_CLIENT_PROTOCOL, MIN_DESKTOP_CLIENT_PROTOCOL } from "@canopy/domain/release/protocol";

export interface GatewayCompatibility {
  state: "ready" | "gateway-update" | "app-update" | "unavailable" | "pairing";
  message: string;
  methods: string[];
  gatewayVersion: string;
}

/** Server-only bearer, supplied by Electron's controller. No service token from the remote server. */
export function desktopGateway(routesJson: string, token: string) {
  const routes = fromJsonString(ui.MobileRoutesSchema, routesJson, { ignoreUnknownFields: true });
  const routed = routedPinnedTransport(routes, token);
  const raw = createClient(ui.GatewayService, routed.transport);

  let snapshot: GatewayCompatibility = {
    state: "unavailable",
    message: "The gateway is not available",
    methods: [],
    gatewayVersion: "",
  };

  let expires = 0;
  let pending: Promise<GatewayCompatibility> | undefined;

  async function refresh(): Promise<GatewayCompatibility> {
    try {
      const info = await raw.getClientCapabilities({}, { timeoutMs: 2500 });

      if (info.routes) routed.update(info.routes);
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
        message: Match.value(state).pipe(
          Match.when("app-update", () => "Update this app to connect to this gateway"),
          Match.when("gateway-update", () => `Update Canopy on ${name} to use this app`),
          Match.orElse(() => ""),
        ),
      };
    } catch (cause) {
      const code = cause instanceof ConnectError ? cause.code : undefined;
      snapshot = {
        state:
          code === Code.Unimplemented ? "gateway-update" : code === Code.Unauthenticated ? "pairing" : "unavailable",
        message:
          code === Code.Unimplemented
            ? "Update Canopy on your gateway to use this app"
            : code === Code.Unauthenticated
              ? "Desktop access was revoked. Pair this app again in gateway Settings → Devices"
              : "The gateway is not available",
        methods: [],
        gatewayVersion: "",
      };
    }

    expires = Date.now() + (snapshot.state === "ready" ? 5000 : 1000);

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
      return await routed.transport.unary(...args);
    } catch (cause) {
      if (cause instanceof ConnectError && cause.code === Code.Unimplemented)
        throw new ConnectError("Update Canopy on your gateway to use this feature", Code.Unimplemented);

      if (cause instanceof ConnectError && cause.code === Code.Unauthenticated) expires = 0;
      throw cause;
    }
  };

  const stream: Transport["stream"] = async (...args) => {
    await requireMethod(args[0].name);

    return routed.transport.stream(...args);
  };

  return { transport: { unary, stream }, compatibility };
}
