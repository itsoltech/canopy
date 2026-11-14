import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallKind } from "@canopy/updater";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The only variables the web process inherits: the system basics, the web's own settings and adapter-node's.
 * Gateway secrets (database URL, secrets key, TLS key) never reach it; it talks to the gateway with the service
 * token. CANOPY_WEB_ORIGIN stays out too: it means the desktop's single-origin BFF.
 */
const INHERITED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "no_proxy",
  "CANOPY_CHANNEL",
  "CANOPY_INSTALL_KIND",
  "CANOPY_LOG_DIR",
  "CANOPY_LOG_SUPERVISED",
  "CANOPY_WEB",
  "CANOPY_WEB_HOST",
  "CANOPY_WEB_PORT",
  "CANOPY_WEB_DIR",
  "CANOPY_WEB_ALLOWED_HOSTS",
  "GATEWAY_URL",
  "ORIGIN",
  "ADDRESS_HEADER",
  "XFF_DEPTH",
  "PORT_HEADER",
  "SHUTDOWN_TIMEOUT",
  "IDLE_TIMEOUT",
  "KEEP_ALIVE_TIMEOUT",
  "HEADERS_TIMEOUT",
]);

export const DEFAULT_WEB_PORT = 3000;

/** `CANOPY_WEB=off` makes a binary or Docker gateway headless; anything but on/off is a configuration error. */
export function embeddedWebWanted(env: Env, kind: InstallKind): boolean {
  const value = env["CANOPY_WEB"]?.trim().toLowerCase();

  if (value !== undefined && value !== "" && value !== "on" && value !== "off")
    throw new Error("CANOPY_WEB must be on or off");

  // The gateway image serves it like the binary (it only updates by a new image); the desktop bundles its own web.
  return (kind === "binary" || kind === "docker") && value !== "off";
}

export interface WebListen {
  host: string;
  port: number;
}

/** The embedded web's listener: loopback only unless CANOPY_WEB_HOST says otherwise (the gateway image sets 0.0.0.0). */
export function webListen(env: Env): WebListen {
  const host = env["CANOPY_WEB_HOST"]?.trim() || "127.0.0.1";
  const port = Number(env["CANOPY_WEB_PORT"] || DEFAULT_WEB_PORT);

  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CANOPY_WEB_PORT must be a port number from 1 to 65535");

  return { host, port };
}

export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();

  return bare === "localhost" || bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127."));
}

const wildcard = (host: string) => host === "0.0.0.0" || host === "::" || host === "[::]";

/** Where this machine reaches the web: a wildcard bind is reached through loopback. */
export function webConnectHost(host: string): string {
  if (wildcard(host)) return "127.0.0.1";

  return isIP(host) === 6 ? `[${host}]` : host;
}

/** The embedded web's origin, for HTTPS over Tailscale when CANOPY_WEB_ORIGIN is not set (docs/tailscale.md). */
export function embeddedWebOrigin(env: Env): string {
  const { host, port } = webListen(env);

  return `http://${webConnectHost(host)}:${port}`;
}

/** The gateway's own listener as the web reaches it on this machine. */
function gatewayUrl(env: Env): string {
  const host = env["CANOPY_HOST"] ?? "0.0.0.0";
  const tls = Boolean(env["CANOPY_TLS_CERT"] && env["CANOPY_TLS_KEY"]);

  return `${tls ? "https" : "http"}://${webConnectHost(host)}:${Number(env["CANOPY_PORT"] ?? 7443)}`;
}

/**
 * The environment of the embedded web (adapter-node + the BFF), derived from the gateway's env file.
 * Explicit adapter-node settings win; HOST/PORT always come from CANOPY_WEB_HOST/CANOPY_WEB_PORT.
 * The forwarded headers suit Tailscale Serve and the usual reverse proxies; a direct request without them
 * is plain HTTP (the embedded server has no TLS), see wrapRequests in serve.ts.
 */
export function webProcessEnv(env: Env) {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(env))
    if (value !== undefined && (INHERITED.has(key) || key.startsWith("LC_"))) out[key] = value;
  const { host, port } = webListen(env);
  const token = env["CANOPY_UI_SERVICE_TOKEN"] || env["GATEWAY_SERVICE_TOKEN"];

  if (!token) throw new Error("CANOPY_UI_SERVICE_TOKEN is not set (shared with the web BFF): openssl rand -hex 32");
  out["HOST"] = host;
  out["PORT"] = String(port);
  out["GATEWAY_SERVICE_TOKEN"] = token;
  out["GATEWAY_URL"] = env["GATEWAY_URL"] || gatewayUrl(env);
  out["PROTOCOL_HEADER"] = env["PROTOCOL_HEADER"] ?? "x-forwarded-proto";
  out["HOST_HEADER"] = env["HOST_HEADER"] ?? "x-forwarded-host";
  out["BODY_SIZE_LIMIT"] = env["BODY_SIZE_LIMIT"] ?? "50M";

  // A self-signed gateway certificate (CANOPY_TLS_CERT) is trusted for this one local connection.
  if (out["GATEWAY_URL"].startsWith("https:") && env["CANOPY_TLS_CERT"] && !env["NODE_EXTRA_CA_CERTS"])
    out["NODE_EXTRA_CA_CERTS"] = env["CANOPY_TLS_CERT"];

  return out;
}

/** Extracted web releases: CANOPY_WEB_DIR, else the user cache directory. */
export function webDirectory(env: Env): string {
  if (env["CANOPY_WEB_DIR"]) return env["CANOPY_WEB_DIR"];

  if (process.platform === "win32")
    return join(env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"), "canopy", "web");

  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "canopy", "web");

  return join(env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "canopy", "web");
}
