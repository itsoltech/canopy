import { readFileSync } from "node:fs";
import { startGrpcServer } from "@open-agents/transport";
import { serviceTokenAuth, uiRoutes } from "./api/index.ts";
import { GatewayCore } from "./core/core.ts";
import { attachmentLimits, ensureDevUser, gatewayRuntime, migrateDatabase } from "./runtime.ts";

// One HTTP/2 server for workers (WorkerLinkService) and the web BFF (GatewayService); docs/ui-api.md.
const env = Bun.env;
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
    uiRoutes(core)(router);
  },
  interceptors: [serviceTokenAuth(serviceToken)],
  host: env["OA_HOST"] ?? "0.0.0.0",
  port: Number(env["OA_PORT"] ?? 7443),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
});
console.info(`gateway listening on ${server.url}`);
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
    await server.close();
    await runtime.dispose();
    process.exit(0);
  });
}
