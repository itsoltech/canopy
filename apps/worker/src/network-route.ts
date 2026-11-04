import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { NetworkRouteStatusSchema, WorkerLinkService, type NetworkRoutes } from "@canopy/contracts";
import { createGrpcClientTransport, pinnedCertificate } from "@canopy/transport";
import type { GatewayLink } from "./gateway-link/index.ts";
import type { GatewayEndpoint, LocalConfig } from "./config/local.ts";
import { saveMigratedConfig } from "./config/migration.ts";

export function endpointOptions(endpoint: GatewayEndpoint) {
  const ca = endpoint.gateway_certificate ?? (endpoint.ca_file ? readFileSync(endpoint.ca_file) : undefined);

  return {
    baseUrl: endpoint.gateway_url,
    ...(ca && { ca }),
    ...(endpoint.gateway_fingerprint && { fingerprint: endpoint.gateway_fingerprint }),
  };
}

/** Keeps serving the existing link while probing; a failed migration cannot fence it or change its config. */
export class WorkerNetworkRoute {
  #local: LocalConfig;
  #endpoint: GatewayEndpoint;
  #detail = "";
  #busy = false;
  #retryAt = 0;
  #lastOffer = "";

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
  }

  get endpoint() {
    return this.#endpoint;
  }

  status() {
    return create(NetworkRouteStatusSchema, {
      route: this.options.localWorker ? "local" : this.#endpoint.gateway_fingerprint ? "pinned" : "server",
      detail: this.#detail,
    });
  }

  /** Prefer the persisted secure route on restart; retain the server route when that route later disappears. */
  failed() {
    const fallback = this.#local.gateway_fallback;

    if (!fallback || this.#endpoint === fallback) return false;
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
        const url = new URL(origin);

        if (url.origin !== origin || url.protocol !== "https:") throw new Error("invalid secure origin");
        const certificate = await pinnedCertificate(origin, routes.fingerprint, this.options.signal);
        target = { gateway_url: origin, gateway_certificate: certificate, gateway_fingerprint: routes.fingerprint };
        await createClient(WorkerLinkService, createGrpcClientTransport(endpointOptions(target))).probeNetworkRoute(
          { workerId: this.#local.worker_id },
          {
            headers: { authorization: `Bearer ${this.#local.credential}` },
            timeoutMs: 5000,
            signal: this.options.signal,
          },
        );
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

function routeFailure(error: Error | undefined) {
  if (error instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied].includes(error.code))
    return "worker authentication rejected";

  if (error instanceof Error && error.message === "Gateway certificate does not match the fingerprint")
    return "certificate fingerprint mismatch";

  if (error instanceof Error && error.message === "invalid secure origin") return "invalid secure address";

  return "address unreachable or secure handshake failed";
}
