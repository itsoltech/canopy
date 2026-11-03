import { readFileSync } from "node:fs";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { startConnectHttpServer, startGrpcServer } from "@canopy/transport";
import { serviceTokenAuth, uiRoutes } from "./api/index.ts";
import { GatewayCore } from "./core/core.ts";
import { healthcheck } from "./healthcheck.ts";
import { attachmentLimits, ensureDevUser, gatewayRuntime, migrateDatabase } from "./runtime.ts";
import { installKind, isStandalone, serviceSnippet, superviseBinary, UPDATE_RESTART_EXIT_CODE } from "@canopy/updater";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { readEnv } from "@canopy/domain/env";

const env = Bun.env;
if (Bun.argv.includes("--version")) { console.info(CANOPY_VERSION); process.exit(0); }
// Docker HEALTHCHECK / probes: before the supervisor, which would start a second gateway.
if (Bun.argv[2] === "healthcheck") process.exit(await healthcheck(env));
if (Bun.argv[2] === "service") {
  console.info(serviceSnippet("gateway", process.platform, process.execPath, isStandalone() ? [] : [Bun.main]));
  process.exit(0);
}
if (installKind() === "binary" && !process.env["CANOPY_SUPERVISED"]) {
  process.exit(await superviseBinary({ binaryPath: process.execPath, args: Bun.argv.slice(2), log: (m) => console.warn(m) }));
}

// One HTTP/2 server for workers (WorkerLinkService) and the web BFF (GatewayService); docs/ui-api.md.
const serviceToken = readEnv("CANOPY_UI_SERVICE_TOKEN", env);
if (!serviceToken) throw new Error("CANOPY_UI_SERVICE_TOKEN is not set (shared with the web BFF): openssl rand -hex 32");

const runtime = gatewayRuntime(env);
if ((readEnv("CANOPY_MIGRATE", env) ?? "1") === "1") {
  const applied = await migrateDatabase(runtime);
  if (applied.length > 0) console.info(`migrations applied: ${applied.join(", ")}`);
}
// Single development user until authentication lands (docs/ui-api.md).
const userId = await ensureDevUser(runtime, readEnv("CANOPY_DEV_USER_EMAIL", env) ?? "dev@localhost");

const publicGatewayUrl = readEnv("CANOPY_PUBLIC_GATEWAY_URL", env);
const mobileGatewayUrl = readEnv("CANOPY_MOBILE_GATEWAY_URL", env);
const core = new GatewayCore({
  runtime,
  instanceId: `${process.pid}@${Bun.env["HOSTNAME"] ?? "gateway"}`,
  userId,
  ...(publicGatewayUrl && { publicGatewayUrl }),
  ...(mobileGatewayUrl && { mobileGatewayUrl }),
  log: (m) => console.info(m),
  attachmentLimits: attachmentLimits(env),
  updates: {
    ...(env["CANOPY_RELEASE_BASE_URL"] && { source: { baseUrl: env["CANOPY_RELEASE_BASE_URL"] } }),
    ...(env["CANOPY_UPDATE_CACHE_DIR"] && { cacheDir: env["CANOPY_UPDATE_CACHE_DIR"] }),
    channel: env["CANOPY_UPDATE_CHANNEL"] ?? "stable",
    restart: async () => { await stop(); process.exit(UPDATE_RESTART_EXIT_CODE); },
    idle: () => runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ idle: boolean }>`SELECT NOT EXISTS (SELECT 1 FROM turns WHERE status = 'running') AND NOT EXISTS (SELECT 1 FROM bot_turns WHERE status = 'running') AS idle`;
      return rows[0]?.idle ?? false;
    })),
    log: (message) => console.info(message),
  },
});
// Workers' configurations follow the global provider instances (e.g. right after the migration to them).
await core.syncProviderInstances();
const certFile = readEnv("CANOPY_TLS_CERT", env);
const keyFile = readEnv("CANOPY_TLS_KEY", env);
const server = await startGrpcServer({
  routes: (router) => {
    core.link.routes(router);
    core.workers.routes(router);
    core.updates.service.routes(router);
    core.mobile.routes(router);
    uiRoutes(core)(router);
  },
  interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
  host: readEnv("CANOPY_HOST", env) ?? "0.0.0.0",
  port: Number(readEnv("CANOPY_PORT", env) ?? 7443),
  health: () => ({ healthy: core.updates.service.verdict().healthy, version: CANOPY_VERSION }),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
});
console.info(`gateway ${CANOPY_VERSION} listening on ${server.url}`);
// Desktop: keep the BFF/API listener on loopback and optionally expose only worker RPCs
// on an explicitly selected private interface. Existing server deployments are unchanged.
const workerHost = readEnv("CANOPY_WORKER_HOST", env);
const workerPort = readEnv("CANOPY_WORKER_PORT", env);
const workerServer = workerHost && workerPort ? await startGrpcServer({
  routes: (router) => { core.link.routes(router); core.workers.routes(router); core.updates.service.routes(router); },
  health: () => ({ healthy: core.updates.service.verdict().healthy, version: CANOPY_VERSION }),
  host: workerHost,
  port: Number(workerPort),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
}) : undefined;
if (workerServer) console.info(`worker-only listener on ${workerServer.url}`);
const mobilePort = readEnv("CANOPY_MOBILE_PORT", env);
const mobileServer = mobilePort ? await startConnectHttpServer({
  // WorkerLink remains on HTTP/2. Phones only need unary + server-streaming UI RPCs.
  routes: (router) => { core.mobile.routes(router); uiRoutes(core)(router); },
  interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
  host: "127.0.0.1",
  port: Number(mobilePort),
}) : undefined;
if (mobileServer) console.info(`mobile Connect listener on ${mobileServer.url} (private TLS proxy required)`);
core.scheduler.start();
// Open items of finished turns, threads stuck in a busy or failed look: fixed now and every few minutes.
core.startSweep();
// Notes about ended background tasks that still wait (Claude's grace, a restart in between): delivered every few seconds.
core.backgroundTasks.start();
core.bots.start();
await core.updates.start();

async function stop() {
    core.updates.close();
    core.secrets.stop();
    await core.scheduler.stop();
    core.stopSweep();
    core.backgroundTasks.stop();
    await core.bots.stop();
    await core.link.shutdown();
    await mobileServer?.close();
    await workerServer?.close();
    await server.close();
    await runtime.dispose();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}
