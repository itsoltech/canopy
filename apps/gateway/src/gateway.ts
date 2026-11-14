import { readFileSync } from "node:fs";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { startGrpcServer } from "@canopy/transport";
import { serviceTokenAuth, uiRoutes } from "./api/index.ts";
import { GatewayCore } from "./core/core.ts";
import { healthcheck } from "./healthcheck.ts";
import { ensureDevUser, gatewayRuntime, migrateDatabase, networkPort, webOrigin } from "./runtime.ts";
import {
  installKind,
  isStandalone,
  onSupervisorHandover,
  readUpdateRecord,
  rollbackBinary,
  serviceSnippet,
  UPDATE_RESTART_EXIT_CODE,
} from "@canopy/updater";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startComputerLinks } from "./computers/start.ts";
import { lanUnavailable, multicastTransport } from "./computers/lan-transport.ts";
import { ComputerStore } from "./computers/store.ts";
import { Tailscale } from "./network/tailscale/tailscale.ts";
import type { TailscaleSnapshot } from "./network/tailscale/status.ts";
import { NetworkAccess } from "./network/network.ts";
import { mountMobileNetwork } from "./network/devices.ts";
import { loadSecretsKey } from "./store/secrets.ts";
import { workerRoutes } from "./worker-link/routes.ts";
import { gatewayRole } from "./role.ts";
import { DatabaseMaintenance } from "./maintenance/job.ts";
import { installLogWriter, runtimeLogDirectory, registeredLogs } from "@canopy/logs";
import { dirname } from "node:path";
import { EMBEDDED_WEB } from "./web/embedded.ts";
import { embeddedWebOrigin, embeddedWebWanted } from "./web/config.ts";
import { EmbeddedWebServer } from "./web/server.ts";
import { WebClientVersions } from "./web/clients.ts";

const env = Bun.env;

/** This machine's MagicDNS names: what Tailscale Serve sends as Host to the embedded web. */
const tailscaleHosts = (snapshot: TailscaleSnapshot) => [snapshot.dnsName, ...snapshot.certDomains].filter(Boolean);

if (Bun.argv.includes("--version")) {
  console.info(CANOPY_VERSION);
  process.exit(0);
}

// Docker HEALTHCHECK / probes: before the supervisor, which would start a second gateway.
if (Bun.argv[2] === "healthcheck")
  process.exit(
    await healthcheck(env, EMBEDDED_WEB && embeddedWebWanted(env, installKind()) ? embeddedWebOrigin(env) : undefined),
  );

if (Bun.argv[2] === "service") {
  console.info(serviceSnippet("gateway", process.platform, process.execPath, isStandalone() ? [] : [Bun.main]));
  process.exit(0);
}

// One HTTP/2 server for workers (WorkerLinkService) and the web BFF (GatewayService); docs/ui-api.md.
const serviceToken = env["CANOPY_UI_SERVICE_TOKEN"];

if (!serviceToken)
  throw new Error("CANOPY_UI_SERVICE_TOKEN is not set (shared with the web BFF): openssl rand -hex 32");

// A binary or Docker gateway serves the web from its own build, in this process, unless CANOPY_WEB=off
// (docs/deploy.md).
const embeddedWeb =
  EMBEDDED_WEB && embeddedWebWanted(env, installKind())
    ? new EmbeddedWebServer({
        archive: EMBEDDED_WEB,
        env,
        log: (m) => console.info(m),
        hosts: () => tailscaleHosts(tailscale.snapshot),
        changed: () => core.feeds.updatesChanged(),
      })
    : undefined;

// Web BFFs of another version, e.g. a retired canopy-web container left in an old Compose file.
const webClients = new WebClientVersions(CANOPY_VERSION, embeddedWeb !== undefined, (m) => console.warn(m));

const runtime = gatewayRuntime(env);
const logDirectory = runtimeLogDirectory("gateway", env);

installLogWriter("gateway", logDirectory, [
  serviceToken,
  env["CANOPY_DATABASE_URL"] ?? "",
  env["CANOPY_SECRETS_KEY"] ?? "",
]);

if ((env["CANOPY_MIGRATE"] ?? "1") === "1") {
  const applied = await migrateDatabase(runtime, env);

  if (applied.length > 0) console.info(`migrations applied: ${applied.join(", ")}`);
}

// Single development user until authentication lands (docs/ui-api.md).
const userId = await ensureDevUser(runtime, env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost");

const core = new GatewayCore({
  role: gatewayRole(env),
  runtime,
  diagnosticsLogDirectory: dirname(logDirectory),
  logSources: [
    ...registeredLogs(
      logDirectory,
      env["CANOPY_LOG_SUPERVISED"] === "1" ? ["desktop", "gateway", "postgres", "web", "initdb"] : ["gateway"],
    ),
    ...(env["CANOPY_LOG_SUPERVISED"] !== "1" && env["CANOPY_POSTGRES_LOG_FILE"]
      ? [{ source: "postgres" as const, file: env["CANOPY_POSTGRES_LOG_FILE"], rotationVerified: false }]
      : []),
  ],
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
    notice: () => [embeddedWeb?.notice, webClients.notice].filter(Boolean).join(" "),
  },
});

if (installKind() === "binary")
  onSupervisorHandover(
    () => core.updates.handover(),
    (message) => console.info(message),
  );

const computerStore = new ComputerStore(runtime, userId, loadSecretsKey(env));
const fixedPort = networkPort(env);
const web = webOrigin(env) ?? (embeddedWeb && embeddedWebOrigin(env));

// This host's Tailscale, read-only; absent (Docker, most servers) is just a state (docs/tailscale.md).
const tailscale = new Tailscale({ log: (m) => console.info(m) });

void tailscale.start();

tailscale.onChange(() => embeddedWeb?.hostsChanged());

// Phones and linked computers: one pinned TLS listener, switched on in Settings → Network access.
const network = new NetworkAccess({
  role: core.role,
  store: computerStore,
  tailscale,
  ...(web && { webOrigin: web }),
  ...(fixedPort !== undefined && { port: fixedPort }),
  log: (m) => console.info(m),
});

core.network = network;

const unmountMobile = mountMobileNetwork(core, network, serviceToken);

await startComputerLinks(core, computerStore, network, {
  transport: multicastTransport,
  ...(lanUnavailable(env) && { unavailable: lanUnavailable(env)! }),
});

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
  interceptors: [
    core.diagnostics.interceptor,
    serviceTokenAuth(serviceToken, core.mobile, (version) => webClients.seen(version)),
  ],
  host: env["CANOPY_HOST"] ?? "0.0.0.0",
  port: Number(env["CANOPY_PORT"] ?? 7443),
  health: () => ({ healthy: core.updates.service.verdict().healthy, version: CANOPY_VERSION }),
  ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
});

console.info(`gateway ${CANOPY_VERSION} listening on ${server.url}`);

// Before updates.start confirms this version. An update candidate whose web can't start rolls back both, with the
// web's reason; otherwise the gateway runs on and the web retries (web/process.ts).
const record = installKind() === "binary" ? await readUpdateRecord() : undefined;
const candidate = record?.state === "restarting" && record.version === CANOPY_VERSION;

await embeddedWeb?.start(candidate).catch(async (cause: unknown) => {
  const reason = `The web app of ${CANOPY_VERSION} didn't start: ${cause instanceof Error ? cause.message : String(cause)}`;
  console.error(reason);
  await rollbackBinary(process.execPath, reason);
  // The supervisor restarts the restored executable; its record already says failed.
  process.exit(UPDATE_RESTART_EXIT_CODE);
});

core.scheduler.start();

void core.diagnostics.start();

const maintenance = new DatabaseMaintenance(runtime, userId);

maintenance.start();

// Open items of finished turns, threads stuck in a busy or failed look: fixed now and every few minutes.
core.startSweep();

// Notes about ended background tasks that still wait (Claude's grace, a restart in between): delivered every few seconds.
core.backgroundTasks.start();

core.bots.start();

await core.updates.start();

core.updateCenter.start();

async function stop(presence = "shutting_down") {
  await embeddedWeb?.stop();
  await core.computers?.close(presence);
  unmountMobile();
  await network.close();
  tailscale.close();
  core.updateCenter.stop();
  core.updates.close();
  core.desktopControl.close();
  core.appControl.close();
  core.secrets.stop();
  await core.scheduler.stop();
  await maintenance.stop();
  await core.stopSweep();
  core.backgroundTasks.stop();
  await core.bots.stop();
  await core.link.shutdown();
  await core.diagnostics.stop();
  await server.close();
  await runtime.dispose();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}
