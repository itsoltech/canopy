import { gatewayOrigin } from "./client";
import { RouteDiagnostics, routeKind, type RouteOutcome } from "./route-diagnostics";
import { FAILED_FOR, raceRoutes } from "./route-race";
import { probeRoute } from "./route-probe";
import type { MobileConnection, PinnedTransport } from "./routes";

/** Identity ties responses to one selection, including when a failed address is selected again. */
export interface SelectedRoute {
  address: string;
}

/** A route stays selected until failure or reset. Elapsed time and quiet streams never start probes. */
export class RouteSelector {
  addresses: string[];
  readonly diagnostics: RouteDiagnostics;
  readonly failed = new Map<string, number>();
  generation = 0;
  #chosen: SelectedRoute | undefined;
  #racing: Promise<SelectedRoute> | undefined;
  #controller = new AbortController();
  #lastAddress: string | undefined;
  #unsaved: boolean;

  constructor(
    readonly saved: MobileConnection,
    readonly transport: PinnedTransport,
    readonly planned: () => boolean,
  ) {
    this.addresses = normalizedRoutes(saved.addresses);
    this.#lastAddress = this.addresses.includes(saved.lastAddress ?? "") ? saved.lastAddress : undefined;
    this.#unsaved = saved.addresses.join() !== this.addresses.join() || this.#lastAddress !== saved.lastAddress;
    this.diagnostics = new RouteDiagnostics(this.addresses);
  }

  connection() {
    return {
      fingerprint: this.saved.fingerprint,
      addresses: this.addresses,
      ...(this.#lastAddress && { lastAddress: this.#lastAddress }),
    };
  }

  async select(signal?: AbortSignal | null): Promise<SelectedRoute> {
    signal?.throwIfAborted();

    if (this.#chosen) return this.#chosen;
    const generation = this.generation;
    const preferred = this.planned() ? this.#lastAddress : undefined;

    const shared = (this.#racing ??= (
      preferred
        ? probeRoute(this.transport, preferred, this.saved.fingerprint, this.#controller.signal, 2000).then(
            () => preferred,
          )
        : raceRoutes({
            candidates: this.order(),
            fingerprint: this.saved.fingerprint,
            transport: this.transport,
            diagnostics: this.diagnostics,
            failed: this.failed,
            signal: this.#controller.signal,
          })
    )
      .then((address) => {
        const route = { address };

        if (generation === this.generation) {
          this.#chosen = route;
          this.diagnostics.update({ active: address });
        }

        return route;
      })
      .finally(() => {
        if (generation === this.generation) this.#racing = undefined;
      }));

    if (!signal) return shared;

    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  order() {
    const rank = (address: string) => {
      if ((this.failed.get(address) ?? 0) > Date.now()) return 4;

      // Avoid dependency on phone DNS when an equally pinned tailnet IP is available.
      if (routeKind(address) === "Tailscale" && !new URL(address).hostname.endsWith(".ts.net")) return 0;

      return address === this.#lastAddress ? 1 : 2;
    };

    return [...this.addresses].sort((a, b) => rank(a) - rank(b));
  }

  /** Headers and stream chunks/heartbeats are health evidence only for the still-current selection. */
  succeeded(route: SelectedRoute) {
    if (this.#chosen !== route) return false;
    this.failed.delete(route.address);
    const changed = this.#unsaved || this.#lastAddress !== route.address;
    this.#unsaved = false;
    this.#lastAddress = route.address;

    return changed;
  }

  failedRequest(route: SelectedRoute, outcome: RouteOutcome, started: number) {
    if (this.#chosen !== route) return;
    this.failed.set(route.address, Date.now() + FAILED_FOR);
    this.#chosen = undefined;
    this.diagnostics.result(route.address, outcome, started, "request");
    this.diagnostics.update({ active: undefined });
  }

  update(addresses: string[]) {
    if (!this.#chosen || !addresses.includes(this.#chosen.address)) {
      this.reset(addresses);

      return;
    }

    // An unrelated interface or hostname changed; keep the working connection and its streams.
    this.addresses = addresses;
    this.diagnostics.reset(addresses, this.#chosen.address);
  }

  reset(addresses = this.addresses) {
    this.generation++;
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#racing = undefined;
    this.#chosen = undefined;
    this.failed.clear();
    this.addresses = addresses;

    if (!addresses.includes(this.#lastAddress ?? "")) this.#lastAddress = undefined;
    this.diagnostics.reset(addresses);
    this.transport.reset();
  }
}

export function normalizedRoutes(addresses: string[]) {
  if (!addresses.length || addresses.length > 32) throw new Error("A pairing needs between 1 and 32 addresses.");

  const routes = [...new Set(addresses.map((a) => gatewayOrigin(a)))].filter((address) => {
    const host = new URL(address).hostname;
    const parts = host.split(".").map(Number);

    const privateLan =
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31);

    // Older gateways advertised virtual LAN network addresses. Pairing has no subnet mask;
    // conservatively ignore private IPv4 .0 candidates, leaving tailnet and public host routes alone.
    return !(parts.length === 4 && privateLan && parts[3] === 0);
  });

  if (!routes.length) throw new Error("A pairing needs between 1 and 32 addresses.");

  return routes;
}
