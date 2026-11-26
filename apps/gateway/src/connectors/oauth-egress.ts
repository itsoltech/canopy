import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect, checkServerIdentity } from "node:tls";
import { CONNECTOR_TYPES, connectorUrl } from "./catalog.ts";
import { connectPinned, OAuthConnectFailure, OAuthNetworkFailure, type Address } from "./oauth-network.ts";

const blocked = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] satisfies [string, number][])
  blocked.addSubnet(address, prefix, "ipv4");

blocked.addAddress("168.63.129.16", "ipv4");

const globalV6 = new BlockList();

globalV6.addSubnet("2000::", 3, "ipv6");

blocked.addSubnet("2001::", 23, "ipv6");

blocked.addSubnet("2001:db8::", 32, "ipv6");

blocked.addSubnet("2002::", 16, "ipv6");

blocked.addSubnet("3fff::", 20, "ipv6");

function publicAddress(address: string): boolean {
  const family = isIP(address);

  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

const resolveHost = (host: string) => lookup(host, { all: true });
const vendorOrigins = new Set(CONNECTOR_TYPES.flatMap((type) => (type.url ? [new URL(type.url).origin] : [])));

export class OAuthEndpointRedirect extends Error {
  constructor(readonly status: number) {
    super("OAuth endpoint redirected");
  }
}

async function sendPinned(
  url: URL,
  address: Address,
  input: Request,
  signal: AbortSignal,
  body: Buffer | undefined,
): Promise<Response> {
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const tcp = await connectPinned(address, port, signal);
  const request = secure ? httpsRequest : httpRequest;

  try {
    return await new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          protocol: url.protocol,
          hostname,
          port,
          path: url.pathname + url.search,
          method: input.method,
          headers: { ...Object.fromEntries(input.headers), host: url.host, "accept-encoding": "identity" },
          createConnection: () =>
            secure
              ? tlsConnect({
                  socket: tcp,
                  host: hostname,
                  ...(!isIP(hostname) && { servername: hostname }),
                  checkServerIdentity: (_, cert) => checkServerIdentity(hostname, cert),
                })
              : tcp,
          signal,
        },
        (res) => {
          const status = res.statusCode ?? 502;

          if (status >= 300 && status < 400) {
            res.destroy();
            reject(new OAuthEndpointRedirect(status));

            return;
          }

          const headers = new Headers();

          for (const [name, value] of Object.entries(res.headers))
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);

          if (status === 204 || status === 205 || input.method === "HEAD") {
            res.resume();
            resolve(new Response(null, { status, headers }));

            return;
          }

          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
                res.pause();
              });
              res.on("end", () => controller.close());
              res.on("error", (error) => controller.error(error));
            },
            pull() {
              res.resume();
            },
            cancel() {
              res.destroy();
            },
          });

          resolve(new Response(stream, { status, headers }));
        },
      );

      req.once("error", reject);
      req.end(body);
    });
  } catch (error) {
    tcp.destroy();
    throw error;
  }
}

type OriginAddresses = { all: Address[]; preferred?: Address };

/** Only authority entered by the owner can designate a private origin. Discovery cannot extend it. */
export function oauthEgress(
  resource: string,
  registeredIssuer?: string,
  options: {
    publicOrigins?: readonly string[] | undefined;
    resolve?: typeof resolveHost;
    send?: typeof sendPinned;
  } = {},
) {
  const resourceOrigin = new URL(resource).origin;
  const registeredOrigin = registeredIssuer ? new URL(registeredIssuer).origin : undefined;
  const configured = new Set([resourceOrigin, ...(registeredOrigin ? [registeredOrigin] : [])]);
  const publicOrigins = new Set(options.publicOrigins?.filter((origin) => configured.has(origin)));
  const origins = new Map<string, Promise<OriginAddresses>>();
  const resolve = options.resolve ?? resolveHost;
  const send = options.send ?? sendPinned;

  async function addresses(url: URL) {
    connectorUrl(`${url.origin}${url.pathname}`);

    if (url.username || url.password || url.hash) throw new Error("Invalid OAuth endpoint");
    const existing = origins.get(url.origin);

    if (existing) return existing;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(host);

    const answers = family
      ? Promise.resolve([{ address: host, family }])
      : resolve(host).catch(() => {
          throw new OAuthNetworkFailure("dns");
        });

    const validated = answers.then((all): OriginAddresses => {
      if (!all.length) throw new OAuthNetworkFailure("dns");

      if (all.some((a) => !isIP(a.address) || isIP(a.address) !== a.family))
        throw new Error("OAuth endpoint unavailable");

      if (all.every((a) => publicAddress(a.address))) {
        if (configured.has(url.origin)) publicOrigins.add(url.origin);
      } else if (
        !configured.has(url.origin) ||
        publicOrigins.has(url.origin) ||
        vendorOrigins.has(url.origin) ||
        all.some((a) => publicAddress(a.address))
      )
        throw new Error("OAuth endpoint requires a public address");

      return { all };
    });

    origins.set(url.origin, validated);

    return validated;
  }

  async function sendToOrigin(url: URL, origin: OriginAddresses, req: Request, signal: AbortSignal) {
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    const { all, preferred } = origin;
    const candidates = preferred ? [preferred, ...all.filter((address) => address !== preferred)] : all;

    for (const [index, address] of candidates.entries()) {
      try {
        signal.throwIfAborted();
        const response = await send(url, address, req, signal, body);
        origin.preferred ??= address;

        return response;
      } catch (error) {
        if (!(error instanceof OAuthConnectFailure)) throw error;

        if (origin.preferred === address) delete origin.preferred;

        if (signal.aborted || index === candidates.length - 1) throw error;
      }
    }

    throw new OAuthNetworkFailure("dns");
  }

  return {
    publicOrigins: () => [...publicOrigins].sort(),
    discardRegisteredIssuer: () => {
      if (!registeredOrigin || registeredOrigin === resourceOrigin) return;
      configured.delete(registeredOrigin);

      // A pinned private address must no longer be reachable through this transport.
      if (!publicOrigins.delete(registeredOrigin)) origins.delete(registeredOrigin);
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const url = new URL(req.url);
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]);
      const aborted = Promise.withResolvers<never>();
      const cancel = () => aborted.reject(new OAuthNetworkFailure("timeout"));
      signal.addEventListener("abort", cancel, { once: true });

      try {
        signal.throwIfAborted();
        const origin = await Promise.race([addresses(url), aborted.promise]);

        try {
          return await sendToOrigin(url, origin, req, signal);
        } catch (error) {
          if (signal.aborted) throw new OAuthNetworkFailure("timeout");

          if (error instanceof OAuthEndpointRedirect || error instanceof OAuthNetworkFailure) throw error;
          throw new OAuthNetworkFailure("transport");
        }
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
