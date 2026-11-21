import { readFileSync } from "node:fs";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { startGrpcServer } from "@canopy/transport";
import { gatewayProcessApi } from "./api/process-routes.ts";
import { GatewayCore } from "./core/core.ts";
import { settleInterruptedWorktreePreparations } from "./core/worktree-preparation.ts";
import { initializeModuleExecution } from "./store/module-transitions.ts";
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
import { gatewayRole } from "./role.ts";
import { DatabaseMaintenance } from "./maintenance/job.ts";
import { databaseUrl } from "./database-credentials.ts";
import { installLogWriter, runtimeLogDirectory, registeredLogs } from "@canopy/logs";
import { dirname } from "node:path";
import { EMBEDDED_WEB } from "./web/embedded.ts";
import { embeddedWebOrigin, embeddedWebWanted } from "./web/config.ts";
import { EmbeddedWebServer } from "./web/server.ts";
import { WebClientVersions } from "./web/clients.ts";
import { gatewayStorageOptions } from "./diagnostics/storage-roots.ts";
import { coreState } from "./core/core-context.ts";
import { RelocationRuntime, StartupFenced } from "./migration/relocation-fence-runtime.ts";

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

installLogWriter("gateway", logDirectory, [serviceToken, databaseUrl(env), env["CANOPY_SECRETS_KEY"] ?? ""]);

function startupRejected(error: Error): never {
  console.error(
    error instanceof StartupFenced
      ? error.message
      : "Could not verify the gateway relocation fence at startup. Check PostgreSQL and apply migration 0188.",
  );
  process.exit(1);
}

const relocation = await RelocationRuntime.open(env).catch(startupRejected);

if ((env["CANOPY_MIGRATE"] ?? "1") === "1") {
  const applied = await migrateDatabase(runtime, env);

  if (applied.length > 0) console.info(`migrations applied: ${applied.join(", ")}`);
}

await relocation.assertReady().catch(startupRejected);

// Single development user until authentication lands (docs/ui-api.md).
const userId = await ensureDevUser(runtime, env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost");

await runtime.runPromise(initializeModuleExecution(userId));

const core = new GatewayCore({
  role: gatewayRole(env),
  runtime,
  relocation,
  diagnosticsStorage: gatewayStorageOptions(env, {
    logs: logDirectory,
    spool: () => core.diagnostics.logs.directory,
    updates: () => core.updates.cacheDirectory,
    web: () => embeddedWeb?.storageDirectory,
    kind: installKind(),
  }),
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
      // The executable is already staged. Startup checks the durable fence before serving.
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

const maintenance = new DatabaseMaintenance(runtime, userId, (ids) => core.threadsChanged(ids));
let unmountMobile: (() => void) | undefined;
let server: Awaited<ReturnType<typeof startGrpcServer>> | undefined;
let stopping: Promise<void> | undefined;
let relocationTimer: ReturnType<typeof setInterval> | undefined;
let polling: Promise<void> | undefined;
let guardRetryAfter = 0;
let startupComplete = false;
let intake: "starting" | "running" | "paused" = "starting";

const startup = start(serviceToken);

try {
  const exitCode = await startup;

  if (exitCode !== undefined) await stopAndExit(exitCode);
} catch (error) {
  await stop().catch(() => console.error("Gateway shutdown could not complete"));

  if (error instanceof StartupFenced) startupRejected(error);
  throw error;
}

startupComplete = true;

await pollRelocation();

async function start(serviceToken: string): Promise<number | undefined> {
  await settleInterruptedWorktreePreparations(core);
  await relocation.assertReady();

  // Even though the listeners may open before web and updater startup complete, admission must
  // follow the fence from the first listener. Drain and cleanup wait for any in-flight setup.
  relocationTimer = setInterval(() => void pollRelocation(), 250);
  await pollRelocation();

  if (stopping) return undefined;
  unmountMobile = mountMobileNetwork(core, network, serviceToken, relocation.interceptor);

  await startComputerLinks(core, computerStore, network, {
    transport: multicastTransport,
    ...(lanUnavailable(env) && { unavailable: lanUnavailable(env)! }),
  });

  if (stopping) return undefined;
  await network.start();

  if (network.listening) console.info(`network access on port ${network.port}`);
  await core.syncProviderInstances();

  if (stopping) return undefined;
  const certFile = env["CANOPY_TLS_CERT"];
  const keyFile = env["CANOPY_TLS_KEY"];
  const processApi = gatewayProcessApi(core, serviceToken, (version) => webClients.seen(version));
  server = await startGrpcServer({
    routes: processApi.routes,
    interceptors: [relocation.interceptor, core.diagnostics.interceptor, processApi.auth],
    host: env["CANOPY_HOST"] ?? "0.0.0.0",
    port: Number(env["CANOPY_PORT"] ?? 7443),
    health: () => ({
      healthy: !relocation.draining && core.updates.service.verdict().healthy,
      version: CANOPY_VERSION,
    }),
    ...(certFile && keyFile && { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }),
  });
  console.info(`gateway ${CANOPY_VERSION} listening on ${server.url}`);

  // A candidate's web must answer before updates.start confirms this version.
  const record = installKind() === "binary" ? await readUpdateRecord() : undefined;
  const candidate = record?.state === "restarting" && record.version === CANOPY_VERSION;

  try {
    await embeddedWeb?.start(candidate);
  } catch (cause) {
    const reason = `The web app of ${CANOPY_VERSION} didn't start: ${cause instanceof Error ? cause.message : String(cause)}`;
    console.error(reason);
    await rollbackBinary(process.execPath, reason);

    return UPDATE_RESTART_EXIT_CODE;
  }

  if (stopping) return undefined;
  await core.updates.start();

  return undefined;
}

function startIntake() {
  if (intake === "running") return;

  if (intake === "starting") {
    void core.diagnostics.start();
    maintenance.start();
    core.startSweep();
    core.backgroundTasks.start();
    core.bots.start();
  } else void core.sweep().catch(() => console.error("Gateway relocation: queue resume will retry"));

  intake = "running";
  core.scheduler.start();
  core.messengers.start();
  core.updateCenter.start();
}

function pollRelocation() {
  if (stopping || Date.now() < guardRetryAfter) return;

  return (polling ??= checkRelocation().finally(() => {
    polling = undefined;
  }));
}

async function checkRelocation() {
  const wasRelocating = relocation.relocating;

  try {
    const idle = await relocation.refresh();

    if (stopping) return;

    if (idle === undefined) {
      if (!guardRetryAfter) console.warn("Gateway relocation guard lost its database connection and will retry");
      guardRetryAfter = Date.now() + 1000;
    } else guardRetryAfter = 0;

    if (!wasRelocating && relocation.relocating) console.info("Gateway relocation: waiting for active work to finish");

    if (!startupComplete) return;

    if (!relocation.draining) {
      startIntake();

      return;
    }

    if (intake === "running") {
      intake = "paused";
      core.updateCenter.stop();
      await Promise.all([core.scheduler.stop(), core.messengers.stop()]);

      return;
    }

    if (
      idle === true &&
      relocation.requestsIdle &&
      core[coreState].pumpAdmissions === 0 &&
      core[coreState].commandDeliveries === 0 &&
      core[coreState].workerToolCalls === 0 &&
      core[coreState].titleJobs.size === 0 &&
      core.bots.idle &&
      [...core.link.connections.values()].every((connection) => connection.idle) &&
      (await relocation.claimShutdown())
    ) {
      void stopAndExit(0);
    }
  } catch (error) {
    if (stopping) return;
    console.error(
      error instanceof StartupFenced ? error.message : "Gateway relocation guard could not confirm database state",
    );
    // A failed shutdown claim may already hold the session lock. Complete shutdown before releasing it.
    void stopAndExit(1);
  }
}

async function stopAndExit(code: number) {
  try {
    await stop();
  } catch {
    console.error("Gateway shutdown could not complete");
    process.exit(1);
  }

  process.exit(code);
}

function stop(presence = "shutting_down") {
  return (stopping ??= close(presence));
}

async function close(presence: string) {
  clearInterval(relocationTimer);
  await startup.catch(() => {});
  await polling;

  try {
    await embeddedWeb?.stop();
    await core.computers?.close(presence);
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
    await core.messengers.stop();
    await core.bots.stop();
    await core.link.shutdown();
    unmountMobile?.();
    await network.close();
    await core.diagnostics.stop();
    await server?.close();
  } finally {
    await runtime.dispose().finally(() => relocation.close());
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stopAndExit(0));
}
