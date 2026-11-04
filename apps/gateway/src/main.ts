import { readFileSync } from "node:fs";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { startGrpcServer } from "@canopy/transport";
import { remoteServe, serviceTokenAuth, sharedHost, uiHandlers, uiRoutes } from "./api/index.ts";
import { GatewayCore } from "./core/core.ts";
import { healthcheck } from "./healthcheck.ts";
import { ensureDevUser, gatewayRuntime, migrateDatabase, networkPort } from "./runtime.ts";
import {
  installKind,
  isStandalone,
  onSupervisorHandover,
  serviceSnippet,
  superviseBinary,
  UPDATE_RESTART_EXIT_CODE,
} from "@canopy/updater";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { LinkedComputers } from "./computers/runtime.ts";
import { lanUnavailable, multicastTransport } from "./computers/lan-transport.ts";
import { ComputerStore } from "./computers/store.ts";
import { NetworkAccess } from "./network/network.ts";
import { mountMobileNetwork } from "./network/devices.ts";
import { loadSecretsKey } from "./store/secrets.ts";
import { workerRoutes } from "./worker-link/routes.ts";

const env = Bun.env;

if (Bun.argv.includes("--version")) {
  console.info(CANOPY_VERSION);
  process.exit(0);
}

// Docker HEALTHCHECK / probes: before the supervisor, which would start a second gateway.
if (Bun.argv[2] === "healthcheck") process.exit(await healthcheck(env));

if (Bun.argv[2] === "service") {
  console.info(serviceSnippet("gateway", process.platform, process.execPath, isStandalone() ? [] : [Bun.main]));
  process.exit(0);
}

if (installKind() === "binary" && !process.env["CANOPY_SUPERVISED"]) {
  process.exit(
    await superviseBinary({ binaryPath: process.execPath, args: Bun.argv.slice(2), log: (m) => console.warn(m) }),
  );
}

// One HTTP/2 server for workers (WorkerLinkService) and the web BFF (GatewayService); docs/ui-api.md.
const serviceToken = env["CANOPY_UI_SERVICE_TOKEN"];

if (!serviceToken)
  throw new Error("CANOPY_UI_SERVICE_TOKEN is not set (shared with the web BFF): openssl rand -hex 32");

const runtime = gatewayRuntime(env);

if ((env["CANOPY_MIGRATE"] ?? "1") === "1") {
  const applied = await migrateDatabase(runtime);

  if (applied.length > 0) console.info(`migrations applied: ${applied.join(", ")}`);
}

// Single development user until authentication lands (docs/ui-api.md).
const userId = await ensureDevUser(runtime, env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost");

const core = new GatewayCore({
  runtime,
  instanceId: `${process.pid}@${Bun.env["HOSTNAME"] ?? "gateway"}`,
  userId,
  log: (m) => console.info(m),
  updates: {
    ...(env["CANOPY_RELEASE_BASE_URL"] && { source: { baseUrl: env["CANOPY_RELEASE_BASE_URL"] } }),
    ...(env["CANOPY_UPDATE_CACHE_DIR"] && { cacheDir: env["CANOPY_UPDATE_CACHE_DIR"] }),
    channel: env["CANOPY_UPDATE_CHANNEL"] ?? "stable",
    restart: async (exitCode = UPDATE_RESTART_EXIT_CODE) => {
      await stop("updating");
      process.exit(exitCode);
    },
    idle: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* sql<{
            idle: boolean;
          }>`SELECT NOT EXISTS (SELECT 1 FROM turns WHERE status = 'running') AND NOT EXISTS (SELECT 1 FROM bot_turns WHERE status = 'running') AS idle`;

          return rows[0]?.idle ?? false;
        }),
      ),
    log: (message) => console.info(message),
  },
});

if (installKind() === "binary")
  onSupervisorHandover(
    () => core.updates.handover(),
    (message) => console.info(message),
  );

// Workers' configurations follow the global provider instances (e.g. right after the migration to them).
const own = uiHandlers(core);

const computerStore = new ComputerStore(runtime, userId, loadSecretsKey(env));
const fixedPort = networkPort(env);

// Phones and linked computers: one pinned TLS listener, switched on in Settings → Network access.
const network = new NetworkAccess({
  store: computerStore,
  ...(fixedPort !== undefined && { port: fixedPort }),
  log: (m) => console.info(m),
});

core.network = network;

const unmountMobile = mountMobileNetwork(core, network, serviceToken);

core.computers = new LinkedComputers({
  store: computerStore,
  network,
  serve: remoteServe(own, core),
  shared: sharedHost(core, own),
  core,
  zone: async () => (await core.settings()).user?.timezone,
  discovery: { transport: multicastTransport, ...(lanUnavailable(env) && { unavailable: lanUnavailable(env)! }) },
});

await core.computers.start();

await network.start();

if (network.listening) console.info(`network access on port ${network.port}`);

await core.syncProviderInstances();

const certFile = env["CANOPY_TLS_CERT"];
const keyFile = env["CANOPY_TLS_KEY"];

const server = await startGrpcServer({
  routes: (router) => {
    workerRoutes(core, router);
    uiRoutes(core)(router);
  },
  interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
  host: env["CANOPY_HOST"] ?? "0.0.0.0",
  port: Number(env["CANOPY_PORT"] ?? 7443),
  health: () => ({ healthy: core.updates.service.verdict().healthy, version: CANOPY_VERSION }),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
});

console.info(`gateway ${CANOPY_VERSION} listening on ${server.url}`);

core.scheduler.start();

// Open items of finished turns, threads stuck in a busy or failed look: fixed now and every few minutes.
core.startSweep();

// Notes about ended background tasks that still wait (Claude's grace, a restart in between): delivered every few seconds.
core.backgroundTasks.start();

core.bots.start();

await core.updates.start();

async function stop(presence = "shutting_down") {
  await core.computers?.close(presence);
  unmountMobile();
  await network.close();
  core.updates.close();
  core.desktopControl.close();
  core.secrets.stop();
  await core.scheduler.stop();
  await core.stopSweep();
  core.backgroundTasks.stop();
  await core.bots.stop();
  await core.link.shutdown();
  await server.close();
  await runtime.dispose();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}
