import { readFileSync } from "node:fs";
import { startGrpcServer } from "@open-agents/transport";
import { createWorkerLink } from "./worker-link/index.ts";

// Temporary until enrollment + PostgreSQL land: OA_WORKER_TOKENS="token1=worker-1,token2=worker-2".
const workerTokens = new Map(
  (Bun.env["OA_WORKER_TOKENS"] ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=", 2) as [string, string]),
);

const certFile = Bun.env["OA_TLS_CERT"];
const keyFile = Bun.env["OA_TLS_KEY"];

const link = createWorkerLink({
  authenticate: async (credential) => workerTokens.get(credential),
  welcome: async () => ({ heartbeatIntervalSeconds: 15 }),
  onConnected: (connection) => {
    console.info(`worker ${connection.workerId} connected (${connection.hello.host?.hostname ?? "?"})`);
    void connection.closed.then(() => console.info(`worker ${connection.workerId} disconnected`));
  },
});

const server = await startGrpcServer({
  routes: link.routes,
  host: Bun.env["OA_HOST"] ?? "0.0.0.0",
  port: Number(Bun.env["OA_PORT"] ?? 7443),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
});
console.info(`gateway listening on ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await link.shutdown();
    await server.close();
    process.exit(0);
  });
}
