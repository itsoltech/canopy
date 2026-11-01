import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

export interface TlsMaterial {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
}

export interface GrpcServerOptions {
  readonly routes: (router: ConnectRouter) => void;
  readonly host?: string;
  /** 0 picks a free port. */
  readonly port?: number;
  /** Without TLS the server speaks h2c (cleartext HTTP/2), e.g. behind a TLS-terminating proxy. */
  readonly tls?: TlsMaterial;
}

export interface RunningGrpcServer {
  readonly port: number;
  readonly url: string;
  /**
   * Stops accepting connections, sends GOAWAY to open sessions and waits up to `graceMs`
   * for their streams to finish. Sessions still open after that are destroyed.
   * End long-lived streams first (e.g. WorkerLink.shutdown()) so clients get a clean status.
   */
  close(graceMs?: number): Promise<void>;
}

/** HTTP/2 server serving Connect, gRPC and gRPC-Web on one port. */
export async function startGrpcServer(options: GrpcServerOptions): Promise<RunningGrpcServer> {
  const handler = connectNodeAdapter({ routes: options.routes });
  const server = options.tls
    ? http2.createSecureServer({ cert: options.tls.cert, key: options.tls.key, allowHTTP1: true }, handler)
    : http2.createServer(handler);

  const sessions = new Set<http2.Http2Session>();
  server.on("session", (session: http2.Http2Session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const scheme = options.tls ? "https" : "http";

  return {
    port,
    url: `${scheme}://${host}:${port}`,
    close: (graceMs = 5_000) =>
      new Promise<void>((resolve) => {
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const session of sessions) session.close();
        const timer = setTimeout(() => {
          for (const session of sessions) session.destroy();
        }, graceMs);
      }),
  };
}
