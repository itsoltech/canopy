import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";
import { EMBEDDED_WEB } from "./embedded.ts";
import { isLoopback, webDirectory, webListen, webProcessEnv } from "./config.ts";
import { prepareWebRelease } from "./release.ts";

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

function sendAsset(request: IncomingMessage, response: ServerResponse, file: string) {
  response.writeHead(200, {
    "content-type": Bun.file(file).type,
    "content-length": statSync(file).size,
    "cache-control": "public,max-age=31536000,immutable",
  });

  if (request.method === "HEAD") response.end();
  else pipeline(createReadStream(file), response, () => {});
}

/**
 * Wraps adapter-node's request handler: previous releases' assets first, and a request without the
 * configured protocol header is plain HTTP (this server has no TLS). Tailscale Serve and reverse proxies
 * send `X-Forwarded-Proto: https`; a browser cannot add that header to a cross-site form post.
 */
export function wrapRequests(server: Server, assets: ReadonlyMap<string, string>, protocolHeader: string): void {
  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    if (protocolHeader && request.headers[protocolHeader] === undefined) request.headers[protocolHeader] = "http";
    const path = (request.url ?? "").split("?")[0] ?? "";
    const asset = request.method === "GET" || request.method === "HEAD" ? assets.get(path) : undefined;

    if (asset) return sendAsset(request, response, asset);

    for (const handler of handlers) handler.call(server, request, response);
  });
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
    console.error("This canopy-gateway build has no embedded web. Use a release binary or the canopy-web image.");

    return 78;
  }

  const env = webProcessEnv(process.env);

  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const { host, port } = webListen(process.env);

  if (!isLoopback(host))
    console.warn(
      `web: listening on ${host}:${port}, reachable from other computers. Put a TLS reverse proxy or Tailscale Serve in front of it.`,
    );

  const release = await prepareWebRelease(EMBEDDED_WEB, webDirectory(process.env), (m) => console.warn(m));
  const parent = Number(process.env["CANOPY_WEB_PARENT_PID"]);

  if (Number.isInteger(parent) && parent > 0) exitWithParent(parent);
  const loaded: { server?: object } = await import(pathToFileURL(join(release.directory, "index.js")).href);

  if (!(loaded.server instanceof Server)) throw new Error("The embedded web build does not export its server");
  wrapRequests(
    loaded.server,
    previousAssets(release.directory, release.previous),
    (process.env["PROTOCOL_HEADER"] ?? "").toLowerCase(),
  );
  // adapter-node closes its server on SIGTERM/SIGINT; open SSE streams must not hold the process.
  process.on("sveltekit:shutdown", () => process.exit(0));

  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => setTimeout(() => process.exit(0), 5000).unref());

  return undefined;
}
