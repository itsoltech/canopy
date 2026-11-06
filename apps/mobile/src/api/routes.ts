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
}

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

  async function select(signal?: AbortSignal | null) {
    const order = [...addresses].sort((a, b) => {
      const rank = (address: string) => ((failed.get(address) ?? 0) > Date.now() ? 2 : address === lastAddress ? 0 : 1);

      return rank(a) - rank(b);
    });

    const codes = new Set<string>();

    for (const address of order) {
      signal?.throwIfAborted();

      try {
        await options.transport.probe(address, fingerprint, signal);

        return address;
      } catch (error) {
        signal?.throwIfAborted();
        failed.set(address, Date.now() + 10_000);

        if (error instanceof ProbeError) codes.add(error.code);
      }
    }

    const reasons = codes.size ? ` (${[...codes].join(", ")})` : "";
    throw new Error(
      `Cannot reach this computer securely. Connect to a shared Wi-Fi or VPN, or scan a new pairing code if its addresses changed.${reasons}`,
    );
  }

  // SAFETY: Connect uses only the fetch call signature, never Bun's static fetch.preconnect.
  const fetch = (async (input, init) => {
    const address = await select(init?.signal);
    const source = new URL(input instanceof Request ? input.url : String(input));

    try {
      const response = await options.transport.fetch(`${address}${source.pathname}${source.search}`, init, fingerprint);
      failed.delete(address);

      if (lastAddress !== address) {
        lastAddress = address;
        options.changed?.({ fingerprint, addresses, lastAddress });
      }

      return response;
    } catch (error) {
      failed.set(address, Date.now() + 10_000);
      throw error;
    }
  }) as typeof globalThis.fetch;

  const client = mobileClient({ gatewayUrl: addresses[0]!, ...(options.token && { token: options.token }), fetch });

  return {
    ...client,
    connection: () => ({ fingerprint, addresses, ...(lastAddress && { lastAddress }) }),
    update(routes: MobileConnection) {
      // Route announcements may change addresses, never trust. Changing the pin requires pairing again.
      if (routes.fingerprint !== fingerprint || !routes.addresses.length) return;
      const next = normalized(routes.addresses);

      if (next.join() === addresses.join()) return;
      addresses = next;
      options.changed?.({ fingerprint, addresses, ...(lastAddress && { lastAddress }) });
    },
  };
}

function normalized(addresses: string[]) {
  if (!addresses.length || addresses.length > 32) throw new Error("A pairing needs between 1 and 32 addresses.");

  return [...new Set(addresses.map((a) => gatewayOrigin(a)))];
}
