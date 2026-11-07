import * as http2 from "node:http2";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

export type Handler = (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void | Promise<void>;

export type Listener = { host: string; port: number; close: (graceMs?: number) => Promise<void> };

/** How often an idle peer must answer an HTTP/2 PING, and how long it has to answer. */
export type Liveness = { intervalMs: number; timeoutMs: number };

const LIVENESS: Liveness = { intervalMs: 20_000, timeoutMs: 10_000 };

/** One TLS port for phones and linked computers. TLS proves this computer's pinned certificate to
 * both; a linked computer also presents its own certificate, so `route` sends it to the link service,
 * everything else to the device services (or nowhere). HTTP/2 and HTTP/1.1 are both accepted. */
export async function openListener(options: {
  host: string;
  port: number;
  identity: { certificate: string; privateKey: string };
  route: (socket: TLSSocket) => Handler | undefined;
  liveness?: Liveness;
}): Promise<Listener> {
  const server = http2.createSecureServer(
    {
      cert: options.identity.certificate,
      key: options.identity.privateKey,
      // Linked computers insist on TLS 1.3 themselves; older phones may still need 1.2.
      minVersion: "TLSv1.2",
      allowHTTP1: true,
      // A client certificate is optional: phones have none, a new computer pairs with a new one.
      requestCert: true,
      rejectUnauthorized: false,
      handshakeTimeout: 5000,
      settings: { maxConcurrentStreams: 16 },
    },
    (request, response) => {
      // SAFETY: a secure server only creates requests on TLS sockets.
      const handler = options.route(request.socket as TLSSocket);

      if (handler) return handler(request, response);
      response.writeHead(403);
      response.end();
    },
  );

  const sockets = new Set<Socket>();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
    watchLiveness(session, options.liveness ?? LIVENESS);
  });
  server.on("secureConnection", (socket: Socket) => {
    sockets.add(socket);
    // HTTP/1.1 has no PING; the system's keepalive ends a connection whose peer is gone.
    socket.setKeepAlive(true, LIVENESS.intervalMs);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const destroy = () => {
    clearTimeout(timer);

    for (const socket of sockets) socket.destroy();
  };

  return {
    host: options.host,
    // SAFETY: listen completed on a TCP host/port, so address() is an AddressInfo.
    port: (server.address() as AddressInfo).port,
    close: (graceMs = 0) => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });

        // GOAWAY keeps existing RPCs/streams alive while new connections use the new port.
        for (const session of sessions) session.close();
      });

      if (graceMs > 0) timer ??= setTimeout(destroy, graceMs);
      else destroy();

      return closing;
    },
  };
}

/** A phone that was suspended or lost its network never closes its connection, and its open streams (and their
 * overview subscriptions) would stay forever. A session that doesn't answer a PING in time is destroyed. */
function watchLiveness(session: http2.ServerHttp2Session, liveness: Liveness) {
  let waiting: ReturnType<typeof setTimeout> | undefined;

  const timer = setInterval(() => {
    if (waiting || session.destroyed) return;
    waiting = setTimeout(() => session.destroy(), liveness.timeoutMs);

    try {
      session.ping((error) => {
        clearTimeout(waiting);
        waiting = undefined;

        if (error && !session.destroyed) session.destroy();
      });
    } catch {
      session.destroy();
    }
  }, liveness.intervalMs);

  timer.unref();
  session.once("close", () => {
    clearInterval(timer);
    clearTimeout(waiting);
  });
}

/** Listen on every interface: IPv6 with IPv4 mapped when the system has IPv6, IPv4 only otherwise. */
export async function openEverywhere(options: Omit<Parameters<typeof openListener>[0], "host">) {
  try {
    return await openListener({ ...options, host: "::" });
  } catch (error) {
    const code = error instanceof Error ? errorCode(error) : "";

    if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;

    return openListener({ ...options, host: "0.0.0.0" });
  }
}

const CODES = [
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "EAFNOSUPPORT",
  "EADDRNOTAVAIL",
  "EHOSTUNREACH",
  "ENETUNREACH",
] as const;

export type SystemCode = (typeof CODES)[number] | "";

/** The system error code of a failed listen or connect, read where the error is caught. */
export function errorCode(error: Error | undefined): SystemCode {
  return CODES.find((code) => error && "code" in error && error.code === code) ?? "";
}

/** What the user can do when the port can't be opened. */
export function listenError(code: SystemCode, port: number) {
  if (code === "EADDRINUSE") return `Port ${port} is already used by another app. Choose another port.`;

  if (code === "EACCES" || code === "EPERM")
    return `This computer doesn't allow Canopy to use port ${port}. Choose a port above 1024.`;

  return `Canopy couldn't open port ${port}. Choose another port or try again.`;
}
