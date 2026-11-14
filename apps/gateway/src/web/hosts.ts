import { isIP } from "node:net";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The `Host` names the embedded web answers (DNS rebinding: a page on evil.example that resolves to this
 * machine is same-origin with it, so the raw Host is checked before anything else). IP literals and
 * loopback names cannot be rebound and always pass; other names must be configured:
 * CANOPY_WEB_ALLOWED_HOSTS (`canopy.example.com`, `.example.com` for subdomains), ORIGIN, a named
 * CANOPY_WEB_HOST, and this machine's Tailscale MagicDNS names, which the gateway sends at runtime.
 * Forwarded headers never count: a script on a rebound page can set them.
 */
export class HostAllowlist {
  readonly #configured: string[];
  #runtime: string[] = [];
  constructor(env: Env) {
    const origin = env["ORIGIN"] ? URL.parse(env["ORIGIN"])?.hostname : undefined;
    const listen = env["CANOPY_WEB_HOST"]?.trim();

    this.#configured = [
      ...(env["CANOPY_WEB_ALLOWED_HOSTS"] ?? "").split(/[\s,]+/),
      origin ?? "",
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
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** `name[:port]` or `[v6][:port]` → the bare, lower-case name or address; "" when malformed. */
export function hostName(header: string): string {
  const value = header.trim().toLowerCase();

  if (value.startsWith("[")) {
    const end = value.indexOf("]");

    return end > 0 && /^(:\d+)?$/.test(value.slice(end + 1)) ? value.slice(1, end) : "";
  }

  const match = /^([a-z0-9.-]+)(:\d+)?$/.exec(value);

  return match ? match[1]!.replace(/\.$/, "") : "";
}
