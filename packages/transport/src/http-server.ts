import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { GrpcServerOptions, RunningGrpcServer } from "./server.ts";

/** Loopback Connect + gRPC-Web over HTTP/1.1 for local tooling. Devices use the pinned Network access listener. */
export async function startConnectHttpServer(options: Omit<GrpcServerOptions, "tls">): Promise<RunningGrpcServer> {
  const handler = connectNodeAdapter({
    routes: options.routes,
    ...(options.interceptors && { interceptors: options.interceptors }),
    grpc: false,
    readMaxBytes: 32 * 1024 * 1024,
  });

  const server = http.createServer((request, response) => {
    response.setHeader("cache-control", "no-store");

    // Native-only endpoint. Browsers use the BFF; never open permissive CORS for device tokens.
    if (request.headers.origin) {
      response.writeHead(403);
      response.end();

      return;
    }

    void handler(request, response);
  });

  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // SAFETY: listen() above bound a TCP host and port; address() returns a string only for pipes and Unix sockets.
  const { port } = server.address() as AddressInfo;

  return {
    port,
    url: `http://${host}:${port}`,
    close: (graceMs = 5_000) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, graceMs);

        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
