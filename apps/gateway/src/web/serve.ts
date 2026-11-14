import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";
import { EMBEDDED_WEB } from "./embedded.ts";
import { isLoopback, webDirectory, webListen, webProcessEnv } from "./config.ts";
import { prepareWebRelease, TOUCH_MS, touchWebRelease } from "./release.ts";
import { HostAllowlist } from "./hosts.ts";
import { WEB_HOSTS_MESSAGE, WEB_INSTANCE_HEADER } from "./protocol.ts";
import { installKind } from "@canopy/updater";
import { isString } from "@canopy/domain/json";

const IMMUTABLE = "_app/immutable";

/**
 * Hashed assets of the previous retained releases that this build lacks. adapter-node serves only its own
 * build-time file table, so after an update a tab still on the old version loads its lazy chunks from here
 * (the same window as `apps/web/releases`, docs/ui-api.md).
 */
export function previousAssets(current: string, previous: readonly string[]): Map<string, string> {
  const assets = new Map<string, string>();

  for (const release of previous) {
    const root = join(release, "client", IMMUTABLE);

    if (!existsSync(root)) continue;

    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const path = join(root, file);
      const key = `/${IMMUTABLE}/${file.split(sep).join("/")}`;

      if (/\.(gz|br)$/.test(file) || assets.has(key) || existsSync(join(current, "client", IMMUTABLE, file))) continue;

      if (statSync(path).isFile()) assets.set(key, path);
    }
  }

  return assets;
}

/** False when the file is gone (its release pruned by another instance meanwhile): adapter-node answers then. */
function sendAsset(request: IncomingMessage, response: ServerResponse, file: string): boolean {
  let size: number;

  try {
    size = statSync(file).size;
  } catch {
    return false;
  }

  response.writeHead(200, {
    "content-type": Bun.file(file).type,
    "content-length": size,
    "cache-control": "public,max-age=31536000,immutable",
  });

  if (request.method === "HEAD") response.end();
  else pipeline(createReadStream(file), response, () => {});

  return true;
}

export interface RequestGuards {
  /** Hashed assets of retained releases (previousAssets). */
  assets: ReadonlyMap<string, string>;
  /** adapter-node's PROTOCOL_HEADER, lower case; "" when unset. */
  protocolHeader: string;
  hosts: HostAllowlist;
  /** Answered on /api/health so the gateway knows this process, not an older one on the port, is healthy. */
  instance: string;
}

/**
 * Wraps adapter-node's request handler. First the raw Host (DNS rebinding, hosts.ts), then previous releases'
 * assets; a request without the configured protocol header is plain HTTP (this server has no TLS). Tailscale
 * Serve and reverse proxies send `X-Forwarded-Proto: https`; a browser cannot add it to a cross-site form post.
 */
export function wrapRequests(server: Server, guards: RequestGuards): void {
  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    if (!guards.hosts.allows(request.headers.host)) {
      response.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("This host name isn't allowed. Add it to CANOPY_WEB_ALLOWED_HOSTS on the Canopy gateway.\n");

      return;
    }

    if (guards.protocolHeader && request.headers[guards.protocolHeader] === undefined)
      request.headers[guards.protocolHeader] = "http";
    const path = (request.url ?? "").split("?")[0] ?? "";
    const asset = request.method === "GET" || request.method === "HEAD" ? guards.assets.get(path) : undefined;

    if (asset && sendAsset(request, response, asset)) return;

    if (path === "/api/health" && guards.instance) response.setHeader(WEB_INSTANCE_HEADER, guards.instance);

    for (const handler of handlers) handler.call(server, request, response);
  });
}

/** Runtime Host names from the gateway (Tailscale MagicDNS), over the spawn's IPC channel. */
function receiveHosts(hosts: HostAllowlist) {
  process.on("message", (message) => {
    if (isHostsMessage(message)) hosts.runtime = message.hosts;
  });
}

/** IPC from the gateway (Bun `serialization: "json"`). */
function isHostsMessage(message: unknown): message is { readonly hosts: readonly string[] } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === WEB_HOSTS_MESSAGE &&
    "hosts" in message &&
    Array.isArray(message.hosts) &&
    message.hosts.every(isString)
  );
}

/** An orphaned web (the gateway was killed) must not keep the port: it exits with its parent. */
function exitWithParent(pid: number) {
  setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") process.exit(0);
    }
  }, 2000).unref();
}

/** `canopy-gateway web`: the embedded web BFF in this process, configured from the gateway's env file. */
export async function serveEmbeddedWeb(): Promise<number | undefined> {
  if (!EMBEDDED_WEB) {
    console.error("This canopy-gateway build has no embedded web. Use a release binary or the canopy-gateway image.");

    return 78;
  }

  // Set by the gateway for its own child only; read before the environment is reduced to the web's.
  const parent = Number(process.env["CANOPY_WEB_PARENT_PID"]);
  const instance = process.env["CANOPY_WEB_INSTANCE"] ?? "";
  const env = webProcessEnv(process.env);

  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const { host, port } = webListen(process.env);

  // In a container the published port is the boundary (`127.0.0.1:3000:3000` in Compose), not the bind address.
  if (!isLoopback(host) && installKind() !== "docker")
    console.warn(
      `web: listening on ${host}:${port}, reachable from other computers. Put a TLS reverse proxy or Tailscale Serve in front of it.`,
    );

  const release = await prepareWebRelease(EMBEDDED_WEB, webDirectory(process.env), (m) => console.warn(m));
  setInterval(() => void touchWebRelease(release.directory).catch(() => {}), TOUCH_MS).unref();

  if (Number.isInteger(parent) && parent > 0) exitWithParent(parent);
  const hosts = new HostAllowlist(process.env);
  receiveHosts(hosts);
  const loaded: { server?: object } = await import(pathToFileURL(join(release.directory, "index.js")).href);

  if (!(loaded.server instanceof Server)) throw new Error("The embedded web build does not export its server");
  wrapRequests(loaded.server, {
    assets: previousAssets(release.directory, release.previous),
    protocolHeader: (process.env["PROTOCOL_HEADER"] ?? "").toLowerCase(),
    hosts,
    instance,
  });
  // adapter-node closes its server on SIGTERM/SIGINT; open SSE streams must not hold the process.
  process.on("sveltekit:shutdown", () => process.exit(0));

  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => setTimeout(() => process.exit(0), 5000).unref());

  return undefined;
}
