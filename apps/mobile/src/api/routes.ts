import { gatewayOrigin, mobileClient } from "./client";
import { RouteDiagnostics, routeFailure, routeKind, type RouteOutcome } from "./route-diagnostics";
import { FAILED_FOR, raceRoutes } from "./route-race";
import { ProbeError } from "./route-probe";
import { observeResponse } from "./stream-response";

export { ProbeError } from "./route-probe";

export interface MobileConnection {
  fingerprint: string;
  addresses: string[];
  lastAddress?: string;
}

export interface PinnedTransport {
  /** TLS handshake only; never sends an HTTP request or credential. Includes DNS in the deadline. */
  probe: (origin: string, fingerprint: string, signal?: AbortSignal | null, timeoutMs?: number) => Promise<void>;
  fetch: (input: string, init: RequestInit | undefined, fingerprint: string) => Promise<Response>;
  /** New requests use new connections; requests already running keep theirs. */
  reset: () => void;
}

const KEEP = 30_000;

/** Probe before sending a request. Never replay an RPC after it may have reached the computer. */
export function routedMobileClient(options: {
  connection: MobileConnection;
  token?: string;
  transport: PinnedTransport;
  changed?: (connection: MobileConnection) => void;
}) {
  const { fingerprint } = options.connection;

  if (!/^[a-f0-9]{64}$/i.test(fingerprint))
    throw new Error("Pair this phone again to verify this computer's certificate.");
  const selector = new RouteSelector(options.connection, options.transport);
  const connection = () => selector.connection();

  // SAFETY: Connect invokes only the Fetch call signature, never Bun's static fetch.preconnect.
  const fetch = (async (input, init) => {
    const generation = selector.generation;
    const address = await selector.select(init?.signal);
    init?.signal?.throwIfAborted();

    if (generation !== selector.generation) throw new Error("Connection changed. Try again.");
    const source = new URL(input instanceof Request ? input.url : String(input));
    const started = Date.now();

    try {
      const response = await options.transport.fetch(`${address}${source.pathname}${source.search}`, init, fingerprint);

      if (generation === selector.generation) {
        const changed = selector.succeeded(address);

        if (changed) options.changed?.(connection());
      }

      return observeResponse(response, (error) => {
        if (!init?.signal?.aborted && generation === selector.generation)
          selector.failedRequest(address, routeFailure(error instanceof ProbeError ? error.code : ""), started);
      });
    } catch (error) {
      // A caller canceling a read must not demote a healthy route shared with other requests.
      if (!init?.signal?.aborted && generation === selector.generation)
        selector.failedRequest(address, routeFailure(error instanceof ProbeError ? error.code : ""), started);
      throw error;
    }
  }) as typeof globalThis.fetch;

  const client = mobileClient({
    gatewayUrl: selector.addresses[0]!,
    ...(options.token && { token: options.token }),
    fetch,
  });

  function update(routes: MobileConnection) {
    if (routes.fingerprint !== fingerprint || !routes.addresses.length) return;
    const next = normalized(routes.addresses);

    if (next.join() === selector.addresses.join()) return;
    selector.reset(next);
    options.changed?.(connection());
  }

  return {
    ...client,
    api: {
      ...client.api,
      async updateNetworkAccess(request, callOptions?) {
        const status = await client.api.updateNetworkAccess(request, callOptions);
        update({ fingerprint: status.fingerprint, addresses: status.addresses.map((address) => address.origin) });

        return status;
      },
    } satisfies typeof client.api,
    connection,
    diagnostics: selector.diagnostics,
    update,
    reset: () => selector.reset(),
  };
}

class RouteSelector {
  addresses: string[];
  readonly diagnostics: RouteDiagnostics;
  readonly failed = new Map<string, number>();
  generation = 0;
  #chosen: { address: string; until: number } | undefined;
  #racing: Promise<string> | undefined;
  #controller = new AbortController();
  #lastAddress: string | undefined;

  constructor(
    readonly saved: MobileConnection,
    readonly transport: PinnedTransport,
  ) {
    this.addresses = normalized(saved.addresses);
    this.#lastAddress = saved.lastAddress;
    this.diagnostics = new RouteDiagnostics(this.addresses);
  }

  connection() {
    return {
      fingerprint: this.saved.fingerprint,
      addresses: this.addresses,
      ...(this.#lastAddress && { lastAddress: this.#lastAddress }),
    };
  }

  async select(signal?: AbortSignal | null): Promise<string> {
    signal?.throwIfAborted();

    if (this.#chosen && this.#chosen.until > Date.now()) return this.#chosen.address;
    const generation = this.generation;

    const shared = (this.#racing ??= raceRoutes({
      candidates: this.order(),
      fingerprint: this.saved.fingerprint,
      transport: this.transport,
      diagnostics: this.diagnostics,
      failed: this.failed,
      signal: this.#controller.signal,
    })
      .then((address) => {
        if (generation === this.generation) {
          this.#chosen = { address, until: Date.now() + KEEP };
          this.diagnostics.update({ active: address });
        }

        return address;
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

  succeeded(address: string) {
    this.failed.delete(address);
    this.#chosen = { address, until: Date.now() + KEEP };

    if (this.diagnostics.snapshot().active !== address) this.diagnostics.update({ active: address });
    const changed = this.#lastAddress !== address;

    if (this.addresses.includes(address)) this.#lastAddress = address;

    return changed;
  }

  failedRequest(address: string, outcome: RouteOutcome, started: number) {
    this.failed.set(address, Date.now() + FAILED_FOR);

    if (this.#chosen?.address === address) this.#chosen = undefined;
    this.diagnostics.result(address, outcome, started, "request");

    if (this.diagnostics.snapshot().active === address) this.diagnostics.update({ active: undefined });
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

function normalized(addresses: string[]) {
  if (!addresses.length || addresses.length > 32) throw new Error("A pairing needs between 1 and 32 addresses.");

  return [...new Set(addresses.map((a) => gatewayOrigin(a)))];
}
