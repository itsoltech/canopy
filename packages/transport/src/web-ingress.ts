import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

type Env = Readonly<Record<string, string | undefined>>;

export function webProxyHeaders(env: Env) {
  const scheme = env["PROTOCOL_HEADER"] ?? "x-forwarded-proto";
  const host = env["HOST_HEADER"] ?? "x-forwarded-host";

  // A fixed origin needs two adapter headers even when forwarding was explicitly disabled.
  return {
    PROTOCOL_HEADER: env["ORIGIN"] && !scheme ? "x-forwarded-proto" : scheme,
    HOST_HEADER: env["ORIGIN"] && !host ? "x-forwarded-host" : host,
  };
}

export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();

  return bare === "localhost" || bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127."));
}

/**
 * The `Host` names the server web answers (DNS rebinding: a page on evil.example that resolves to this
 * machine is same-origin with it, so the raw Host is checked before anything else). IP literals and
 * loopback names cannot be rebound and always pass; other names must be configured:
 * CANOPY_WEB_ALLOWED_HOSTS (`canopy.example.com`, `.example.com` for subdomains), ORIGIN, a named
 * CANOPY_WEB_HOST, and this machine's Tailscale MagicDNS names, which the gateway sends at runtime.
 * Forwarded headers never count: a script on a rebound page can set them.
 */
export class WebIngress {
  readonly #configured: string[];
  readonly #origin: URL | undefined;
  readonly #schemeHeader: string;
  readonly #hostHeader: string;
  readonly #portHeader: string | undefined;
  #runtime: string[] = [];
  constructor(env: Env, listen = env["CANOPY_WEB_HOST"]?.trim()) {
    const origin = env["ORIGIN"]?.trim();
    this.#origin = origin ? new URL(origin) : undefined;

    if (
      this.#origin &&
      (!["http:", "https:"].includes(this.#origin.protocol) ||
        this.#origin.username ||
        this.#origin.password ||
        this.#origin.pathname !== "/" ||
        this.#origin.search ||
        this.#origin.hash)
    )
      throw new Error("ORIGIN must be an HTTP or HTTPS origin");
    const headers = webProxyHeaders(env);
    this.#schemeHeader = headers.PROTOCOL_HEADER.toLowerCase();
    this.#hostHeader = headers.HOST_HEADER.toLowerCase();
    this.#portHeader = env["PORT_HEADER"]?.toLowerCase();

    this.#configured = [
      ...(env["CANOPY_WEB_ALLOWED_HOSTS"] ?? "").split(/[\s,]+/),
      this.#origin?.hostname ?? "",
      listen && !isIP(listen) ? listen : "",
    ].flatMap((host) => normalize(host) || []);
  }
  /** Names learned while running (Tailscale); replaces the previous set. */
  set runtime(hosts: readonly string[]) {
    this.#runtime = hosts.flatMap((host) => normalize(host) || []);
  }
  allows(header: string | undefined): boolean {
    const name = hostName(header ?? "");

    if (!name) return false;

    if (isIP(name) || name === "localhost" || name.endsWith(".localhost")) return true;

    return [...this.#configured, ...this.#runtime].some((rule) =>
      rule.startsWith(".") ? name.endsWith(rule) && name.length > rule.length : name === rule,
    );
  }

  /** Check the raw authority before static files, proxy headers or owner credentials are used. */
  admit(request: IncomingMessage, response: ServerResponse): boolean {
    response.setHeader("content-security-policy", "frame-ancestors 'none'");
    response.setHeader("x-frame-options", "DENY");

    if (!this.allows(request.headers.host)) {
      response.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("This host name isn't allowed. Add it to CANOPY_WEB_ALLOWED_HOSTS.\n");

      return false;
    }

    // A fixed public origin takes precedence over proxy metadata, also when the proxy supplies none.
    if (this.#origin) {
      request.headers[this.#schemeHeader] = this.#origin.protocol.slice(0, -1);
      request.headers[this.#hostHeader] = this.#origin.host;

      if (this.#portHeader) delete request.headers[this.#portHeader];
    }

    return true;
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** `name[:port]` or `[v6][:port]` → the bare, lower-case name or address; "" when malformed. */
function hostName(header: string): string {
  const value = header.trim().toLowerCase();
  const match = /^(?:\[([^\]]+)\]|([a-z0-9.-]+))(?::(\d+))?$/.exec(value);

  if (!match || (match[3] && Number(match[3]) > 65535)) return "";

  if (match[1]) return isIP(match[1]) === 6 ? match[1] : "";
  const name = (match[2] ?? "").replace(/\.$/, "");

  return name.length <= 253 && name.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? name
    : "";
}
