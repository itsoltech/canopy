import { mobileClient } from "./client";
import { routeFailure } from "./route-diagnostics";
import { ProbeError } from "./route-probe";
import { normalizedRoutes, RouteSelector } from "./route-selector";
import { observeResponse } from "./stream-response";
import { MobileDeparture, plannedDeparture } from "./departure";

export { ProbeError } from "./route-probe";

export interface MobileConnection {
  fingerprint: string;
  addresses: string[];
  lastAddress?: string;
  departure?: string | undefined;
}

export interface PinnedTransport {
  /** TLS handshake only; never sends an HTTP request or credential. Includes DNS in the deadline. */
  probe: (origin: string, fingerprint: string, signal?: AbortSignal | null, timeoutMs?: number) => Promise<void>;
  fetch: (input: string, init: RequestInit | undefined, fingerprint: string) => Promise<Response>;
  /** New requests use new connections; requests already running keep theirs. */
  reset: () => void;
}

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
  const departure = new MobileDeparture(options.connection.departure, () => options.changed?.(connection()));

  const selector = new RouteSelector(options.connection, options.transport, () =>
    plannedDeparture(departure.snapshot()),
  );

  const connection = () => ({ ...selector.connection(), departure: departure.serialized() });

  // SAFETY: Connect invokes only the Fetch call signature, never Bun's static fetch.preconnect.
  const fetch = (async (input, init) => {
    const generation = selector.generation;
    const route = await selector.select(init?.signal);
    const { address } = route;
    init?.signal?.throwIfAborted();

    if (generation !== selector.generation) throw new Error("Connection changed. Try again.");
    const source = new URL(input instanceof Request ? input.url : String(input));
    const started = Date.now();

    const succeeded = () => {
      if (generation === selector.generation) {
        const changed = selector.succeeded(route);

        if (changed) options.changed?.(connection());
      }
    };

    try {
      const response = await options.transport.fetch(`${address}${source.pathname}${source.search}`, init, fingerprint);
      succeeded();

      return observeResponse(
        response,
        (error) => {
          if (!init?.signal?.aborted && generation === selector.generation)
            selector.failedRequest(route, routeFailure(error instanceof ProbeError ? error.code : ""), started);
        },
        succeeded,
      );
    } catch (error) {
      // A caller canceling a read must not demote a healthy route shared with other requests.
      if (!init?.signal?.aborted && generation === selector.generation)
        selector.failedRequest(route, routeFailure(error instanceof ProbeError ? error.code : ""), started);
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
    const next = normalizedRoutes(routes.addresses);

    if (next.join() === selector.addresses.join()) return;
    selector.update(next);
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
    departure,
    update,
    reset: () => selector.reset(),
  };
}
