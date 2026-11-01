import { readFileSync } from "node:fs";
import { ProviderProfileKind } from "@open-agents/contracts";
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

// Temporary until worker_configs in PostgreSQL is wired: one configuration for every worker, from env.
//   OA_ALLOWED_ROOTS="/home/me/code,/srv/repos"  OA_CLIPROXYAPI_URL / OA_CLIPROXYAPI_API_KEY (optional)
const cliProxyUrl = Bun.env["OA_CLIPROXYAPI_URL"];
const workerConfig = {
  version: 1n,
  allowedRoots: (Bun.env["OA_ALLOWED_ROOTS"] ?? "").split(",").filter(Boolean),
  claude: { enabled: true },
  codex: { enabled: true },
  profiles: cliProxyUrl
    ? [{ id: "cliproxyapi", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: cliProxyUrl, apiKey: Bun.env["OA_CLIPROXYAPI_API_KEY"] ?? "" }]
    : [],
};

const link = createWorkerLink({
  authenticate: async (credential) => workerTokens.get(credential),
  welcome: async () => ({ heartbeatIntervalSeconds: 15 }),
  config: async () => workerConfig,
  onConnected: (connection) => {
    console.info(`worker ${connection.workerId} connected (${connection.hello.host?.hostname ?? "?"})`);
    void (async () => {
      for await (const message of connection.messages) {
        if (message.payload.case === "configApplied") {
          const { version, applied, issues } = message.payload.value;
          console.info(`worker ${connection.workerId} config v${version} ${applied ? "applied" : "REJECTED"}`);
          for (const i of issues) console.info(`  ${i.fatal ? "fatal" : "issue"} ${i.path}: ${i.message}`);
        }
      }
    })().catch(() => {});
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
