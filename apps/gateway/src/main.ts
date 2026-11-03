import { readFileSync } from "node:fs";
import { CANOPY_VERSION } from "@open-agents/domain/release/version";
import { startConnectHttpServer, startGrpcServer } from "@open-agents/transport";
import { serviceTokenAuth, uiRoutes } from "./api/index.ts";
import { GatewayCore } from "./core/core.ts";
import { healthcheck } from "./healthcheck.ts";
import { attachmentLimits, ensureDevUser, gatewayRuntime, migrateDatabase } from "./runtime.ts";

// One HTTP/2 server for workers (WorkerLinkService) and the web BFF (GatewayService); docs/ui-api.md.
const env = Bun.env;
if (Bun.argv[2] === "--version") {
  console.info(CANOPY_VERSION);
  process.exit(0);
}
if (Bun.argv[2] === "healthcheck") process.exit(await healthcheck(env));
const serviceToken = env["OA_UI_SERVICE_TOKEN"];
if (!serviceToken) throw new Error("OA_UI_SERVICE_TOKEN is not set (shared with the web BFF): openssl rand -hex 32");

const runtime = gatewayRuntime(env);
if ((env["OA_MIGRATE"] ?? "1") === "1") {
  const applied = await migrateDatabase(runtime);
  if (applied.length > 0) console.info(`migrations applied: ${applied.join(", ")}`);
}
// Single development user until authentication lands (docs/ui-api.md).
const userId = await ensureDevUser(runtime, env["OA_DEV_USER_EMAIL"] ?? "dev@localhost");

const core = new GatewayCore({
  runtime,
  instanceId: `${process.pid}@${Bun.env["HOSTNAME"] ?? "gateway"}`,
  userId,
  ...(env["OA_PUBLIC_GATEWAY_URL"] && { publicGatewayUrl: env["OA_PUBLIC_GATEWAY_URL"] }),
  ...(env["OA_MOBILE_GATEWAY_URL"] && { mobileGatewayUrl: env["OA_MOBILE_GATEWAY_URL"] }),
  log: (m) => console.info(m),
  attachmentLimits: attachmentLimits(env),
});
// Workers' configurations follow the global provider instances (e.g. right after the migration to them).
await core.syncProviderInstances();
const certFile = env["OA_TLS_CERT"];
const keyFile = env["OA_TLS_KEY"];
const server = await startGrpcServer({
  routes: (router) => {
    core.link.routes(router);
    core.workers.routes(router);
    core.mobile.routes(router);
    uiRoutes(core)(router);
  },
  interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
  host: env["OA_HOST"] ?? "0.0.0.0",
  port: Number(env["OA_PORT"] ?? 7443),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
});
console.info(`gateway ${CANOPY_VERSION} listening on ${server.url}`);
// Desktop: keep the BFF/API listener on loopback and optionally expose only worker RPCs
// on an explicitly selected private interface. Existing server deployments are unchanged.
const workerServer = env["OA_WORKER_HOST"] && env["OA_WORKER_PORT"] ? await startGrpcServer({
  routes: (router) => { core.link.routes(router); core.workers.routes(router); },
  host: env["OA_WORKER_HOST"],
  port: Number(env["OA_WORKER_PORT"]),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
}) : undefined;
if (workerServer) console.info(`worker-only listener on ${workerServer.url}`);
const mobileServer = env["OA_MOBILE_PORT"] ? await startConnectHttpServer({
  // WorkerLink remains on HTTP/2. Phones only need unary + server-streaming UI RPCs.
  routes: (router) => { core.mobile.routes(router); uiRoutes(core)(router); },
  interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
  host: "127.0.0.1",
  port: Number(env["OA_MOBILE_PORT"]),
}) : undefined;
if (mobileServer) console.info(`mobile Connect listener on ${mobileServer.url} (private TLS proxy required)`);
core.scheduler.start();
// Open items of finished turns, threads stuck in a busy or failed look: fixed now and every few minutes.
core.startSweep();
// Notes about ended background tasks that still wait (Claude's grace, a restart in between): delivered every few seconds.
core.backgroundTasks.start();
core.bots.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await core.scheduler.stop();
    core.stopSweep();
    core.backgroundTasks.stop();
    await core.bots.stop();
    await core.link.shutdown();
    await mobileServer?.close();
    await workerServer?.close();
    await server.close();
    await runtime.dispose();
    process.exit(0);
  });
}
