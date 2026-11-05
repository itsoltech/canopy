import type { Server } from "bun";
import { httpsUrl } from "./serve.ts";

/** Who may come in through Canopy's Serve entry, and where the web app is. */
export type FrontPolicy = {
  /** The MagicDNS name and HTTPS port of the Serve entry. */
  host: string;
  port: number;
  /** The Tailscale login allowed in; undefined lets every device of the tailnet in (a tagged server). */
  login: string | undefined;
  /** The web BFF's own origin (CANOPY_WEB_ORIGIN). */
  web: string;
};

// Never passed on: tailscaled's identity headers, proxy headers the BFF would trust, hop-by-hop headers.
const DROPPED =
  /^(host|origin|forwarded|x-forwarded-.*|tailscale-.*|connection|keep-alive|transfer-encoding|te|upgrade|proxy-.*|accept-encoding)$/i;

const refuse = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Whether a request may pass, checked before anything is rewritten (docs/tailscale.md#front). */
export function admit(request: Request, policy: FrontPolicy): Response | undefined {
  const headers = request.headers;

  // Funnel traffic comes from the internet. Canopy never enables Funnel; if someone does, nobody gets in.
  if (headers.has("tailscale-funnel-request")) return refuse(403, "Canopy isn't available over Funnel.");

  const expected = policy.port === 443 ? policy.host : `${policy.host}:${policy.port}`;

  if ((headers.get("host") ?? "").toLowerCase() !== expected) return refuse(421, "Unknown host.");

  if (
    policy.login !== undefined &&
    (headers.get("tailscale-user-login") ?? "").toLowerCase() !== policy.login.toLowerCase()
  )
    return refuse(403, "This Canopy belongs to another Tailscale user.");

  const origin = headers.get("origin");

  if ((origin && origin !== httpsUrl(policy.host, policy.port)) || headers.get("sec-fetch-site") === "cross-site")
    return refuse(403, "Cross-site request refused.");

  return undefined;
}

/** The request as the web BFF expects it: its own host and origin, without tailnet identity headers. */
export function forwarded(request: Request, policy: FrontPolicy) {
  const web = new URL(policy.web);
  const headers = new Headers();

  for (const [name, value] of request.headers) if (!DROPPED.test(name)) headers.set(name, value);

  if (request.headers.has("origin")) headers.set("origin", web.origin);
  headers.set("x-forwarded-proto", web.protocol.slice(0, -1));
  headers.set("x-forwarded-host", web.host);

  const url = new URL(request.url);

  return new Request(new URL(url.pathname + url.search, web).href, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    redirect: "manual",
  });
}

/** The BFF's answer, streamed back (SSE too); redirects to its own origin point at the tailnet URL. */
function answer(response: Response, policy: FrontPolicy) {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  const web = new URL(policy.web).origin;

  if (location?.startsWith(web))
    headers.set("location", httpsUrl(policy.host, policy.port) + location.slice(web.length));

  for (const name of ["connection", "keep-alive", "transfer-encoding"]) headers.delete(name);

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The local front of HTTPS over Tailscale: Serve forwards to it on loopback, it checks who comes in and
 * passes the request to the web BFF. Loopback only: tailscaled and local processes can reach it. */
export class TailscaleFront {
  #server: Server<undefined> | undefined;

  constructor(readonly policy: () => FrontPolicy | undefined) {}

  get port() {
    return this.#server?.port;
  }

  /** Listens on the port (0 = any free one); throws when the port is busy. */
  listen(port: number) {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      // Live updates (SSE) stay open for as long as the page does.
      idleTimeout: 0,
      fetch: async (request) => {
        const policy = this.policy();

        if (!policy) return refuse(503, "HTTPS over Tailscale is off.");
        const refused = admit(request, policy);

        if (refused) return refused;

        try {
          return answer(await fetch(forwarded(request, policy), { decompress: false }), policy);
        } catch {
          return refuse(502, "Canopy's web app isn't answering.");
        }
      },
    });

    if (!this.#server.port) throw new Error("The Tailscale front has no port");

    return this.#server.port;
  }

  async close() {
    await this.#server?.stop(true);
    this.#server = undefined;
  }
}
