import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { createGrpcClientTransport } from "./client.ts";
import { pinnedCertificate } from "./pinned.ts";

export interface PinnedRoutes {
  fingerprint: string;
  addresses: string[];
}

/** A verified route is reused; a background probe may move to a better one this often (ms). */
const REVALIDATE_MS = 30_000;
const PROBE_MS = 2000;

export function pinnedOrigins(addresses: readonly string[]) {
  if (!addresses.length || addresses.length > 32) throw new Error("Use between 1 and 32 gateway addresses");

  return [
    ...new Set(
      addresses.map((address) => {
        const url = new URL(address);

        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
          throw new Error("Use an HTTPS gateway origin without credentials or a path");

        return url.origin;
      }),
    ),
  ];
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Select a verified route before sending. Never replay an RPC that might have committed.
 * Probing every call cost each RPC fresh TLS handshakes to every address; the selected route is kept until a
 * call on it reports Unavailable or a background probe prefers another. Each new connection of a route's
 * transport still checks the pin (client.ts), so reuse never sends the token to an unverified peer.
 */
export function routedPinnedTransport(initial: PinnedRoutes, token?: string) {
  const fingerprint = initial.fingerprint.toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Use the full SHA-256 gateway fingerprint");
  let addresses = pinnedOrigins(initial.addresses);
  let last = "";
  const transports = new Map<string, Transport>();
  let current: { address: string; transport: Transport; checked: number } | undefined;
  let probing: Promise<Transport> | undefined;

  // Race only TLS probes. A stalled address must not prevent a reachable fallback.
  const probe = () =>
    (probing ??= (async () => {
      const complete = new AbortController();
      const deadline = AbortSignal.any([complete.signal, AbortSignal.timeout(PROBE_MS)]);

      try {
        const selected = await Promise.any(
          addresses.map(async (address) => ({
            address,
            certificate: await pinnedCertificate(address, fingerprint, deadline),
          })),
        );

        let transport = transports.get(selected.address);

        if (!transport) {
          transport = createGrpcClientTransport({
            baseUrl: selected.address,
            ca: selected.certificate,
            fingerprint,
            connectTimeoutMs: 1500,
            // Without PINGs a session left half-open by sleep or a route change looks alive forever:
            // its streams stop silently and new ones queue on it. A failed PING ends the session.
            pingIntervalMs: 10_000,
          });
          transports.set(selected.address, transport);
        }

        last = selected.address;
        current = { address: selected.address, transport, checked: Date.now() };

        return transport;
      } catch {
        // A failed background probe keeps a working route; only a failing call drops it.
        throw new ConnectError("The gateway is not available over its pinned TLS connection", Code.Unavailable);
      } finally {
        complete.abort();
        probing = undefined;
      }
    })());

  async function select(signal?: AbortSignal, timeoutMs = PROBE_MS) {
    if (current) {
      if (Date.now() - current.checked >= REVALIDATE_MS) {
        current.checked = Date.now();
        probe().catch(() => {});
      }

      return current.transport;
    }

    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(Math.max(1, Math.min(PROBE_MS, timeoutMs))),
    ]);

    try {
      return await abortable(probe(), deadline);
    } catch (cause) {
      if (signal?.aborted) signal.throwIfAborted();

      if (cause instanceof ConnectError) throw cause;
      throw new ConnectError("The gateway is not available over its pinned TLS connection", Code.Unavailable);
    }
  }

  /**
   * A dead route reports Unavailable (failed connect or PING), or Canceled when its session closes under a call
   * the caller did not abort. The next call probes again.
   */
  const failed = (transport: Transport, cause: unknown, signal: AbortSignal | undefined) => {
    const code = ConnectError.from(cause).code;

    if (current?.transport === transport && (code === Code.Unavailable || (code === Code.Canceled && !signal?.aborted)))
      current = undefined;
  };

  async function* watched<T>(transport: Transport, messages: AsyncIterable<T>, signal: AbortSignal | undefined) {
    try {
      yield* messages;
    } catch (cause) {
      failed(transport, cause, signal);
      throw cause;
    }
  }

  const authorize = (init: ConstructorParameters<typeof Headers>[0]) => {
    const header = new Headers(init);

    if (token) header.set("authorization", `Bearer ${token}`);

    return header;
  };

  const unary: Transport["unary"] = async (...args) => {
    const started = Date.now();
    const timeoutMs = args[2] ?? 3000;
    const transport = await select(args[1], timeoutMs);
    args[2] = Math.max(1, timeoutMs - (Date.now() - started));
    args[3] = authorize(args[3]);

    try {
      return await transport.unary(...args);
    } catch (cause) {
      failed(transport, cause, args[1]);
      throw cause;
    }
  };

  const stream: Transport["stream"] = async (...args) => {
    const transport = await select(args[1]);
    args[3] = authorize(args[3]);

    const response = await transport.stream(...args).catch((cause: unknown) => {
      failed(transport, cause, args[1]);
      throw cause;
    });

    return { ...response, message: watched(transport, response.message, args[1]) };
  };

  return {
    transport: { unary, stream } satisfies Transport,
    update(routes: PinnedRoutes) {
      if (routes.fingerprint.toLowerCase() !== fingerprint || !routes.addresses.length) return;
      // Keep invitation addresses as a bootstrap fallback when network announcements change.
      addresses = [...new Set([...pinnedOrigins(routes.addresses), ...initial.addresses])].slice(0, 32);

      if (current && !addresses.includes(current.address)) current = undefined;
    },
    connection: () => ({ fingerprint, addresses: [...addresses], lastAddress: last }),
  };
}
