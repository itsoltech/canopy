import { readFileSync } from "node:fs";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { NetworkRouteStatusSchema, WorkerLinkService, type NetworkRoutes, ui } from "@canopy/contracts";
import { createGrpcClientTransport, pinnedCertificate, pinnedOrigins, type PinnedRoutes } from "@canopy/transport";
import { installKind } from "@canopy/updater";
import type { GatewayLink } from "./gateway-link/index.ts";
import type { GatewayEndpoint, LocalConfig } from "./config/local.ts";
import { saveMigratedConfig } from "./config/migration.ts";
import { trustedGatewayOrigin } from "./config/gateway-origin.ts";

export function endpointOptions(endpoint: GatewayEndpoint) {
  const ca = endpoint.gateway_certificate ?? (endpoint.ca_file ? readFileSync(endpoint.ca_file) : undefined);

  return {
    baseUrl: endpoint.gateway_url,
    ...(ca && { ca }),
    ...(endpoint.gateway_fingerprint && { fingerprint: endpoint.gateway_fingerprint }),
  };
}

function readDesktopWorkerRoutes(value: string | undefined): PinnedRoutes | undefined {
  if (!value) return undefined;

  try {
    const { fingerprint, addresses } = fromJsonString(ui.MobileRoutesSchema, value);

    if (/^[a-f0-9]{64}$/.test(fingerprint)) return { fingerprint, addresses: pinnedOrigins(addresses) };
  } catch {
    // The saved worker route remains usable independently of the desktop's route hints.
  }

  return undefined;
}

/** Keeps serving the existing link while probing; a failed migration cannot fence it or change its config. */
export class WorkerNetworkRoute {
  #local: LocalConfig;
  #endpoint: GatewayEndpoint;
  #detail = "";
  #busy = false;
  #retryAt = 0;
  #lastOffer = "";
  #desktopRetryAt = 0;
  readonly #desktopRoutes: PinnedRoutes | undefined;

  constructor(
    readonly options: {
      local: LocalConfig;
      configPath: string;
      localWorker?: boolean;
      signal: AbortSignal;
      changed(endpoint: GatewayEndpoint): void;
    },
  ) {
    this.#local = options.local;
    this.#endpoint = options.local;
    this.#desktopRoutes =
      !options.localWorker && installKind() === "desktop"
        ? readDesktopWorkerRoutes(process.env["CANOPY_DESKTOP_WORKER_ROUTES"])
        : undefined;
  }

  get endpoint() {
    return this.#endpoint;
  }

  get desktopWelcomeTimeoutMs() {
    const routes = this.#pairedRoutes;

    if (
      routes &&
      [this.#local.gateway_url, ...routes.addresses].some((origin) => origin !== this.#endpoint.gateway_url)
    )
      return 30_000;

    return undefined;
  }

  get #pairedRoutes() {
    return this.#desktopRoutes?.fingerprint === this.#local.gateway_fingerprint ? this.#desktopRoutes : undefined;
  }

  status() {
    return create(NetworkRouteStatusSchema, {
      route: this.options.localWorker ? "local" : this.#endpoint.gateway_fingerprint ? "pinned" : "server",
      detail: this.#detail,
    });
  }

  /** Pairing only provides hints. Reuse the worker's own pin and prove its credential on the alternate route. */
  async recoverDesktopRoute(error: ConnectError) {
    const { signal } = this.options;
    const desktopRoutes = this.#pairedRoutes;

    if (!desktopRoutes || !routeUnavailable(error) || signal.aborted || this.#busy || Date.now() < this.#desktopRetryAt)
      return false;

    const origins = [...new Set([this.#local.gateway_url, ...desktopRoutes.addresses])]
      .filter((origin) => origin !== this.#endpoint.gateway_url)
      .slice(0, 32);

    if (!origins.length) return false;
    this.#busy = true;
    const probes = new AbortController();
    const deadline = AbortSignal.any([signal, probes.signal, AbortSignal.timeout(5000)]);

    try {
      const target = await Promise.any(
        origins.map((origin) => this.#verifyRoute(origin, desktopRoutes.fingerprint, deadline)),
      );

      if (signal.aborted) return false;
      this.#endpoint = target;
      this.#detail = "";
      this.options.changed(target);

      return true;
    } catch {
      return false;
    } finally {
      probes.abort();
      this.#desktopRetryAt = Date.now() + 30_000;
      this.#busy = false;
    }
  }

  /** A persisted fallback must still meet the worker operator's transport policy at the time of the switch. */
  failed() {
    const fallback = this.#local.gateway_fallback;

    if (!fallback || this.#endpoint === fallback) return false;

    if (
      !trustedGatewayOrigin(
        fallback.gateway_url,
        process.env["CANOPY_WORKER_TRUSTED_HTTP_ORIGIN"] ?? this.#local.trusted_http_origin,
      )
    ) {
      this.#detail = "saved server route requires HTTPS or a locally trusted HTTP origin";

      return false;
    }

    this.#endpoint = fallback;
    this.#detail = "saved secure route could not connect; using the server port";
    this.#retryAt = Date.now() + 60_000;
    this.options.changed(fallback);

    return true;
  }

  async offer(routes: NetworkRoutes, link: GatewayLink) {
    if (this.options.localWorker || this.#busy || this.options.signal.aborted) return;
    const key = JSON.stringify(routes);

    if (key === this.#lastOffer && Date.now() < this.#retryAt) return;
    this.#lastOffer = key;
    this.#retryAt = Date.now() + 60_000;

    if (!routes.origins.length) {
      this.#detail = "";
      this.#report(link);

      return;
    }

    if (
      this.#endpoint.gateway_fingerprint === routes.fingerprint &&
      routes.origins.includes(this.#endpoint.gateway_url)
    )
      return;
    this.#busy = true;

    try {
      await this.#migrate(routes, link);
    } catch {
      this.#detail = "could not save secure route; check worker config permissions and free disk space";
      this.#report(link);
    } finally {
      this.#busy = false;
      this.#retryAt = Date.now() + 60_000;
    }
  }

  async #migrate(routes: NetworkRoutes, link: GatewayLink) {
    const failures: string[] = [];

    for (const origin of routes.origins.slice(0, 32)) {
      if (this.options.signal.aborted) return;
      let target: GatewayEndpoint;

      try {
        target = await this.#verifyRoute(origin, routes.fingerprint, this.options.signal);
      } catch (error) {
        // Fixed diagnostic: transport errors may contain request headers or arbitrary peer text.
        failures.push(routeFailure(error instanceof Error ? error : undefined));
        continue;
      }

      if (this.options.signal.aborted) return;

      const migrated: LocalConfig = {
        ...this.#local,
        ...target,
        gateway_fallback: this.#local.gateway_fallback ?? this.#localEndpoint(),
      };

      saveMigratedConfig(this.options.configPath, this.#local, migrated);
      this.#local = migrated;
      this.#endpoint = migrated;
      this.#detail = "";
      this.options.changed(migrated);
      this.#report(link);
      link.close();

      return;
    }

    this.#detail = `none of ${failures.length} advertised addresses passed verification (${failures[0] ?? "no address"})`;
    this.#report(link);
  }

  async #verifyRoute(origin: string, fingerprint: string, signal: AbortSignal): Promise<GatewayEndpoint> {
    const url = new URL(origin);

    if (url.origin !== origin || url.protocol !== "https:") throw new Error("invalid secure origin");
    const certificate = await pinnedCertificate(origin, fingerprint, signal);
    const target = { gateway_url: origin, gateway_certificate: certificate, gateway_fingerprint: fingerprint };
    await createClient(WorkerLinkService, createGrpcClientTransport(endpointOptions(target))).probeNetworkRoute(
      { workerId: this.#local.worker_id },
      {
        headers: { authorization: `Bearer ${this.#local.credential}` },
        timeoutMs: 5000,
        signal,
      },
    );

    return target;
  }

  #localEndpoint(): GatewayEndpoint {
    return {
      gateway_url: this.#local.gateway_url,
      ...(this.#local.ca_file && { ca_file: this.#local.ca_file }),
      ...(this.#local.gateway_certificate && { gateway_certificate: this.#local.gateway_certificate }),
      ...(this.#local.gateway_fingerprint && { gateway_fingerprint: this.#local.gateway_fingerprint }),
    };
  }

  #report(link: GatewayLink) {
    try {
      link.send({ case: "networkRouteStatus", value: this.status() });
    } catch {
      /* The next Hello reports it. */
    }
  }
}

function routeUnavailable(error: ConnectError) {
  if ([Code.Unavailable, Code.Aborted, Code.Canceled].includes(error.code)) return true;
  const cause = error.cause;

  // connect-node maps socket reachability errors such as ENETUNREACH to Internal.
  if (error.code !== Code.Internal || !(cause instanceof Error) || !("code" in cause)) return false;

  return ["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "EPIPE"].some((code) => code === cause.code);
}

function routeFailure(error: Error | undefined) {
  if (error instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied].includes(error.code))
    return "worker authentication rejected";

  if (error instanceof Error && error.message === "Gateway certificate does not match the fingerprint")
    return "certificate fingerprint mismatch";

  if (error instanceof Error && error.message === "invalid secure origin") return "invalid secure address";

  return "address unreachable or secure handshake failed";
}
