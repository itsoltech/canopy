import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import type { EventEmitter } from "node:events";
import { isLoopback, WebIngress, webProxyHeaders } from "@canopy/transport/web-ingress";
import { isString } from "@canopy/domain/json";

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void | Promise<void>;

type Env = NodeJS.ProcessEnv;

function seconds(env: Env, name: string, fallback: number): number {
  const value = env[name];

  if (!value) return fallback;

  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a nonnegative number of seconds`);

  return Number(value);
}

async function removeStaleSocket(path: string) {
  const before = await lstat(path).catch(() => undefined);

  if (!before?.isSocket()) return;

  const refused = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (cause: NodeJS.ErrnoException) => resolve(cause.code === "ECONNREFUSED"));
  });

  if (!refused) return;
  const after = await lstat(path).catch(() => undefined);

  if (after?.isSocket() && before.dev === after.dev && before.ino === after.ino) await unlink(path);
}

/** The public index.js uses this entry for both a source build and the self-contained release.
 * Load adapter-node only after configuring the origin headers it captures on import. */
export async function startStandaloneWeb(load: () => Promise<{ handler: Handler }>, env: Env = process.env) {
  const host = env["HOST"]?.trim() || env["CANOPY_WEB_HOST"]?.trim() || "127.0.0.1";
  const path = env["SOCKET_PATH"] || undefined;
  const port = Number(env["PORT"] || env["CANOPY_WEB_PORT"] || 3000);
  const hosts = new WebIngress(env, host);
  const headers = webProxyHeaders(env);
  Object.assign(env, headers);
  const protocol = headers.PROTOCOL_HEADER.toLowerCase();
  const pid = Number(env["LISTEN_PID"] || 0);
  const fds = Number(env["LISTEN_FDS"] || 0);

  if (pid && pid !== process.pid) throw new Error("LISTEN_PID must identify this process");

  if (fds > 1) throw new Error("Only one socket is supported for socket activation");

  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be between 0 and 65535");
  const activated = pid === process.pid && fds === 1;
  const idleMs = seconds(env, "IDLE_TIMEOUT", 0) * 1000;
  const shutdownMs = seconds(env, "SHUTDOWN_TIMEOUT", 30) * 1000;
  const { handler } = await load();
  const server = createServer();
  server.keepAliveTimeout = seconds(env, "KEEP_ALIVE_TIMEOUT", server.keepAliveTimeout / 1000) * 1000;
  server.headersTimeout = seconds(env, "HEADERS_TIMEOUT", server.headersTimeout / 1000) * 1000;
  let requests = 0;
  let idle: NodeJS.Timeout | undefined;
  let closing: NodeJS.Timeout | undefined;

  function shutdown(reason: string) {
    if (closing) return;
    clearTimeout(idle);
    closing = setTimeout(() => server.closeAllConnections(), shutdownMs);
    server.close(() => {
      clearTimeout(closing);
      const events: EventEmitter = process;
      events.emit("sveltekit:shutdown", reason);
    });
    server.closeIdleConnections();
  }

  server.on("request", (req, res) => {
    requests++;
    clearTimeout(idle);
    res.once("close", () => {
      requests--;

      if (closing) server.closeIdleConnections();
      else if (activated && idleMs && requests === 0) idle = setTimeout(() => shutdown("IDLE"), idleMs);
    });

    if (!hosts.admit(req, res)) return;

    if (protocol && req.headers[protocol] === undefined) req.headers[protocol] = "http";
    void Promise.resolve()
      .then(() =>
        handler(req, res, () => {
          res.writeHead(404);
          res.end();
        }),
      )
      .catch(() => {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(500, { "cache-control": "no-store" });
          res.end("Could not serve this request.");
        }
      });
  });

  if (path && !activated) await removeStaleSocket(path);
  const stopInt = () => shutdown("SIGINT");
  const stopTerm = () => shutdown("SIGTERM");
  server.once("close", () => {
    clearTimeout(idle);
    process.off("SIGINT", stopInt);
    process.off("SIGTERM", stopTerm);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(activated ? { fd: 3 } : path ? { path } : { host, port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.once("SIGINT", stopInt);
  process.once("SIGTERM", stopTerm);
  const address = server.address();
  const listener = isString(address) ? address : address && `${address.address}:${address.port}`;
  console.info(`web: listening on ${listener}`);

  if (!path && !activated && !isLoopback(host))
    console.warn(
      "web: this listener is reachable from other computers. Restrict access to your authenticated proxy or private network ACL.",
    );

  return { host, path: path ?? false, port: env["PORT"] || env["CANOPY_WEB_PORT"] || (!path && "3000"), server };
}
