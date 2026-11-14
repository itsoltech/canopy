import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { pipeline } from "node:stream";
import type { HostAllowlist } from "./hosts.ts";

const IMMUTABLE = "_app/immutable";

/** adapter-node's request handler (`handler.js` of the web build). */
export type WebHandler = (request: IncomingMessage, response: ServerResponse, next: () => void) => void | Promise<void>;

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
  log: (message: string) => void;
}

/** One request's failure stays with that request: 500 when nothing was sent yet, else the connection closes. */
function failed(request: IncomingMessage, response: ServerResponse, cause: unknown, log: (message: string) => void) {
  log(
    `web: ${request.method} ${(request.url ?? "").split("?")[0]} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  );

  if (response.headersSent) response.destroy();
  else {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Something went wrong in the web app. Try again.\n");
  }
}

/**
 * The web's request listener around adapter-node's handler. First the raw Host (DNS rebinding, hosts.ts), then
 * previous releases' assets; a request without the configured protocol header is plain HTTP (this server has no
 * TLS). Tailscale Serve and reverse proxies send `X-Forwarded-Proto: https`; a browser cannot add it to a
 * cross-site form post. The handler runs inside an error boundary: it shares the gateway's process.
 */
export function webRequestListener(handler: WebHandler, guards: RequestGuards) {
  const notFound = (response: ServerResponse) => () => {
    response.statusCode = 404;
    response.end();
  };

  return (request: IncomingMessage, response: ServerResponse): void => {
    try {
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
      const result = handler(request, response, notFound(response));

      if (result instanceof Promise) result.catch((cause: unknown) => failed(request, response, cause, guards.log));
    } catch (cause) {
      failed(request, response, cause, guards.log);
    }
  };
}
