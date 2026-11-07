import { gatewayOrigin, mobileClient } from "./client";

export interface MobileConnection {
  fingerprint: string;
  addresses: string[];
  lastAddress?: string;
}

export interface PinnedTransport {
  /** TLS handshake only; never sends an HTTP request or credential. */
  probe: (origin: string, fingerprint: string, signal?: AbortSignal | null) => Promise<void>;
  fetch: (input: string, init: RequestInit | undefined, fingerprint: string) => Promise<Response>;
  /** New requests use new connections; requests already running keep theirs. */
  reset: () => void;
}

/** A route that failed goes last for this long. */
const FAILED_FOR = 10_000;

/** Probes start this far apart, so a dead route costs a moment, not its whole timeout. */
const STAGGER = 250;

/** A route that just answered is used again without a new handshake. */
const KEEP = 30_000;

/** A route failed its TLS check; `code` is the native reason (`POSIX 61`, `TLS -9806`, `timeout`). */
export class ProbeError extends Error {
  constructor(readonly code: string) {
    super(`Secure route unavailable (${code})`);
  }
}

/** Try routes before sending a request. Never replay an RPC after it may have reached the computer. */
export function routedMobileClient(options: {
  connection: MobileConnection;
  token?: string;
  transport: PinnedTransport;
  changed?: (connection: MobileConnection) => void;
}) {
  const { fingerprint } = options.connection;

  if (!/^[a-f0-9]{64}$/i.test(fingerprint))
    throw new Error("Pair this phone again to verify this computer's certificate.");
  let addresses = normalized(options.connection.addresses);
  let lastAddress = options.connection.lastAddress;
  const failed = new Map<string, number>();
  let chosen: { address: string; until: number } | undefined;
  let racing: Promise<string> | undefined;

  /** Last working route first, routes that just failed last. */
  function order() {
    const rank = (address: string) => ((failed.get(address) ?? 0) > Date.now() ? 2 : address === lastAddress ? 0 : 1);

    return [...addresses].sort((a, b) => rank(a) - rank(b));
  }

  /** Probes routes in order, each `STAGGER` after the previous one or right after it fails; the first match wins.
   * Every request waiting for a route shares one race, and a canceled request never stops it. */
  function race() {
    const candidates = order();
    const controller = new AbortController();
    const codes = new Set<string>();

    return new Promise<string>((resolve, reject) => {
      let next = 0;
      let running = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const launch = () => {
        clearTimeout(timer);

        if (controller.signal.aborted || next >= candidates.length) return;
        const address = candidates[next++]!;
        running++;
        timer = setTimeout(launch, STAGGER);
        options.transport.probe(address, fingerprint, controller.signal).then(
          () => {
            if (controller.signal.aborted) return;
            controller.abort();
            clearTimeout(timer);
            failed.delete(address);
            resolve(address);
          },
          (error: Error) => {
            if (controller.signal.aborted) return;
            running--;
            failed.set(address, Date.now() + FAILED_FOR);

            if (error instanceof ProbeError) codes.add(error.code);

            if (next < candidates.length) launch();
            else if (!running) {
              controller.abort();
              reject(unreachable(codes));
            }
          },
        );
      };

      launch();
    });
  }

  function select(signal?: AbortSignal | null): Promise<string> {
    signal?.throwIfAborted();

    if (chosen && chosen.until > Date.now() && addresses.includes(chosen.address))
      return Promise.resolve(chosen.address);
    const shared = (racing ??= race().finally(() => (racing = undefined)));

    if (!signal) return shared;

    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  // SAFETY: Connect uses only the fetch call signature, never Bun's static fetch.preconnect.
  const fetch = (async (input, init) => {
    const address = await select(init?.signal);
    const source = new URL(input instanceof Request ? input.url : String(input));

    try {
      const response = await options.transport.fetch(`${address}${source.pathname}${source.search}`, init, fingerprint);
      failed.delete(address);
      chosen = { address, until: Date.now() + KEEP };

      if (lastAddress !== address && addresses.includes(address)) {
        lastAddress = address;
        options.changed?.({ fingerprint, addresses, lastAddress });
      }

      return response;
    } catch (error) {
      failed.set(address, Date.now() + FAILED_FOR);

      if (chosen?.address === address) chosen = undefined;
      throw error;
    }
  }) as typeof globalThis.fetch;

  const client = mobileClient({ gatewayUrl: addresses[0]!, ...(options.token && { token: options.token }), fetch });

  function update(routes: MobileConnection) {
    // Route announcements may change addresses, never trust. Changing the pin requires pairing again.
    if (routes.fingerprint !== fingerprint || !routes.addresses.length) return;
    const next = normalized(routes.addresses);

    if (next.join() === addresses.join()) return;
    addresses = next;

    if (lastAddress && !addresses.includes(lastAddress)) lastAddress = undefined;
    options.changed?.({ fingerprint, addresses, ...(lastAddress && { lastAddress }) });
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
    connection: () => ({ fingerprint, addresses, ...(lastAddress && { lastAddress }) }),
    update,
    /** The network changed or the app returned from the background: pooled connections and the chosen route
     * may be dead, so the next request starts on a fresh connection after a new race. */
    reset() {
      chosen = undefined;
      failed.clear();
      options.transport.reset();
    },
  };
}

function unreachable(codes: Set<string>) {
  const reasons = codes.size ? ` (${[...codes].join(", ")})` : "";

  return new Error(
    `Cannot reach this computer securely. Connect to a shared Wi-Fi or VPN, or scan a new pairing code if its addresses changed.${reasons}`,
  );
}

function normalized(addresses: string[]) {
  if (!addresses.length || addresses.length > 32) throw new Error("A pairing needs between 1 and 32 addresses.");

  return [...new Set(addresses.map((a) => gatewayOrigin(a)))];
}
