import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { createGrpcClientTransport } from "./client.ts";
import { pinnedCertificate } from "./pinned.ts";

export interface PinnedRoutes {
  fingerprint: string;
  addresses: string[];
}

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

/** Select a verified route before sending. Never replay an RPC that might have committed. */
export function routedPinnedTransport(initial: PinnedRoutes, token?: string) {
  const fingerprint = initial.fingerprint.toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Use the full SHA-256 gateway fingerprint");
  let addresses = pinnedOrigins(initial.addresses);
  let last = "";
  const transports = new Map<string, Transport>();

  async function select(signal?: AbortSignal, timeoutMs = 2000) {
    const complete = new AbortController();

    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      complete.signal,
      AbortSignal.timeout(Math.max(1, Math.min(2000, timeoutMs))),
    ]);

    try {
      // Race only TLS probes. A stalled address must not prevent a reachable fallback.
      const selected = await Promise.any(
        addresses.map(async (address) => ({
          address,
          certificate: await pinnedCertificate(address, fingerprint, deadline),
        })),
      );

      last = selected.address;
      let transport = transports.get(last);

      if (!transport) {
        transport = createGrpcClientTransport({
          baseUrl: last,
          ca: selected.certificate,
          fingerprint,
          connectTimeoutMs: 1500,
        });
        transports.set(last, transport);
      }

      return transport;
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      throw new ConnectError("The gateway is not available over its pinned TLS connection", Code.Unavailable);
    } finally {
      complete.abort();
    }
  }

  const unary: Transport["unary"] = async (...args) => {
    const started = Date.now();
    const timeoutMs = args[2] ?? 3000;
    const transport = await select(args[1], timeoutMs);
    args[2] = Math.max(1, timeoutMs - (Date.now() - started));
    const header = new Headers(args[3]);

    if (token) header.set("authorization", `Bearer ${token}`);
    args[3] = header;

    return transport.unary(...args);
  };

  const stream: Transport["stream"] = async (...args) => {
    const transport = await select(args[1]);
    const header = new Headers(args[3]);

    if (token) header.set("authorization", `Bearer ${token}`);
    args[3] = header;

    return transport.stream(...args);
  };

  return {
    transport: { unary, stream } satisfies Transport,
    update(routes: PinnedRoutes) {
      if (routes.fingerprint.toLowerCase() !== fingerprint || !routes.addresses.length) return;
      // Keep invitation addresses as a bootstrap fallback when network announcements change.
      addresses = [...new Set([...pinnedOrigins(routes.addresses), ...initial.addresses])].slice(0, 32);
    },
    connection: () => ({ fingerprint, addresses: [...addresses], lastAddress: last }),
  };
}
