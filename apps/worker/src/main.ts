import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, ManagedRuntime, Result } from "effect";
import { Code, ConnectError } from "@connectrpc/connect";
import { configureWorkloadMemory } from "@canopy/process-governor";
import { WorkerState } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { workerCapabilities } from "./capabilities.ts";
import { defaultConfigPath, defaultDataDir, loadLocalConfig } from "./config/local.ts";
import { resolveWorktreeRoots, type WorktreeRoots } from "./git/worktree-roots.ts";
import { journalHello, openGatewayLink, resendPending, type GatewayLink } from "./gateway-link/index.ts";
import { Journal } from "./journal/index.ts";
import { workerServiceInvocation } from "./runtime/service-invocation.ts";
import { serveLink, WorkerHost } from "./runtime/index.ts";
import { workerCommand, workerServiceSnippet } from "./enroll.ts";
import { enrollFromCli } from "./enrollment-cli.ts";
import { desktopDrain, desktopStatus, workerOnline } from "./desktop-status.ts";
import { installKind, superviseBinary, UPDATE_RESTART_EXIT_CODE } from "@canopy/updater";
import { BinaryWorkerStartup } from "./startup-handover.ts";
import { WorkerUpdates } from "./update-link.ts";
import { applyShellEnv } from "./cli-tools/shell-env.ts";
import { endpointOptions, WorkerNetworkRoute } from "./network-route.ts";
import { GATEWAY_TRANSPORT_MESSAGE, trustedGatewayOrigin } from "./config/gateway-origin.ts";
import { workerDiagnostics } from "./diagnostics/worker.ts";
import { imageExportSelfCheck } from "./images/self-check.ts";
import { LogExporter, LogPullSource, installLogWriter, registeredLogs, cleanLogSpool } from "@canopy/logs";
import { desktopStorageOptions } from "@canopy/logs/desktop-storage";

const cliArgs = Bun.argv.slice(2);

if (cliArgs.includes("--version")) {
  console.info(CANOPY_VERSION);
  process.exit(0);
}

// Release smoke (release.yml): the native image-export calls work on this OS/arch.
if (cliArgs[0] === "self-check") {
  const failure = await imageExportSelfCheck();

  if (failure) console.error(failure);
  process.exit(failure ? 1 : 0);
}

// Docker HEALTHCHECK: healthy while the link to the gateway is up (needs CANOPY_WORKER_STATUS_FILE, see desktop-status.ts).
if (cliArgs[0] === "healthcheck") process.exit(workerOnline(Bun.env) ? 0 : 1);

if (cliArgs[0] === "run") cliArgs.shift();

const command = cliArgs[0] === "enroll" || cliArgs[0] === "service" ? cliArgs.shift() : "start";
let cli;

const valueOptions = new Set(["--gateway", "--config", "--data-dir", "--fingerprint"]);
const boundArgs: string[] = [];

for (let index = 0; index < cliArgs.length; index++) {
  const arg = cliArgs[index]!;
  const value = cliArgs[index + 1];

  if (valueOptions.has(arg) && value !== undefined) {
    boundArgs.push(`${arg}=${value}`);
    index++;
  } else boundArgs.push(arg);
}

try {
  cli = parseArgs({
    args: boundArgs,
    strict: true,
    options: {
      gateway: { type: "string" },
      fingerprint: { type: "string" },
      config: { type: "string" },
      "data-dir": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
  }).values;
} catch {
  console.error(
    "Usage: canopy-worker enroll --gateway URL [--fingerprint SHA256] [--config PATH] [--data-dir DIR] [--force]\n       canopy-worker [--config PATH]\n       canopy-worker service [--config PATH]",
  );
  process.exit(64);
}

const configPath = cli.config ?? defaultConfigPath(Bun.env, process.platform);

// What to type to run this worker: the standalone binary, or Bun with the source entry from the repository root.
const self = workerCommand().length === 1 ? process.execPath : "bun apps/worker/src/main.ts";

if (cli.help) {
  console.info(
    `Canopy worker ${CANOPY_VERSION}\nEnroll: ${self} enroll --gateway URL [--fingerprint SHA256] [--config PATH] [--data-dir DIR] [--force]\nEnter the enrollment token at the prompt or supply it on stdin.\nStart: ${self} [--config PATH]\nService: ${self} service [--config PATH]\nVersion: ${self} --version`,
  );
  process.exit(0);
}

if (command === "enroll") {
  if (!cli.gateway) {
    console.error("--gateway is required");
    process.exit(64);
  }

  process.exit(
    await enrollFromCli(
      {
        gateway: cli.gateway,
        configPath,
        ...(cli.fingerprint && { fingerprint: cli.fingerprint }),
        ...(cli["data-dir"] && { dataDir: cli["data-dir"] }),
        ...(cli.force && { force: true }),
      },
      self,
    ),
  );
}

if (command === "service") {
  console.info(workerServiceSnippet(process.platform, configPath));
  process.exit(0);
}

if (installKind() === "binary" && !process.env["CANOPY_SUPERVISED"]) {
  process.exit(
    await superviseBinary({ binaryPath: process.execPath, args: Bun.argv.slice(2), log: (m) => console.warn(m) }),
  );
}

const WORKER_VERSION = CANOPY_VERSION;

/** How long a graceful stop waits for the gateway to ack what it recorded (stopped background tasks). */
const SHUTDOWN_FLUSH_MS = 3_000;

// Local config is only how to reach the gateway; everything else arrives as WorkerConfig.
const loaded = await loadLocalConfig(configPath, process.platform);

if (Result.isFailure(loaded)) {
  console.error(loaded.failure);
  process.exit(78); // EX_CONFIG: the supervisor should not restart in a loop
}

const local = loaded.success;

if (
  !trustedGatewayOrigin(local.gateway_url, Bun.env["CANOPY_WORKER_TRUSTED_HTTP_ORIGIN"] ?? local.trusted_http_origin)
) {
  console.error(GATEWAY_TRANSPORT_MESSAGE);
  process.exit(78);
}

// The user's login-shell PATH (bun, Volta, nvm, …) for CLI discovery and harnesses; discovery waits for it.
if (installKind() !== "docker") void applyShellEnv();

const dataDir = resolve(local.data_dir ?? defaultDataDir(Bun.env, process.platform));

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const logDirectory = Bun.env["CANOPY_LOG_DIR"] || join(dataDir, "logs");

installLogWriter("worker", logDirectory, [local.credential]);

configureWorkloadMemory((message) => console.info(message));

await cleanLogSpool(dataDir);

const logSource = new LogPullSource(
  new LogExporter(registeredLogs(logDirectory, ["worker"])),
  join(dataDir, "diagnostics-log-spool", "worker"),
);

// Durable outbox: every thread event goes through the journal before it is sent (docs/durability.md, 3.1).
const workerMetricsEnabled = process.env["CANOPY_BENCH_WORKER_DIAGNOSTICS"] !== "0";

const runtime = ManagedRuntime.make(
  Journal.layer(join(dataDir, "journal.db"), workerMetricsEnabled, workerServiceInvocation()),
);

const { journalId } = await runtime.runPromise(journalHello());
let worktreeRoots: WorktreeRoots;

try {
  worktreeRoots = resolveWorktreeRoots({
    dataDir,
    override: Bun.env["CANOPY_WORKTREES_ROOT"] ?? "",
    log: (m) => console.warn(m),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "the worktree root cannot be created");
  process.exit(78);
}

const localWorker = Bun.env["CANOPY_LOCAL_WORKER"] === "1";

const host = new WorkerHost({
  runtime,
  dataDir,
  clientVersion: WORKER_VERSION,
  worktreeRoots,
  log: (m) => console.info(m),
  fullAccess: local.full_access !== false,
  localWorker,
});

if (workerMetricsEnabled)
  workerDiagnostics.start(
    dataDir,
    await runtime.runPromise(Journal.use((journal) => Effect.succeed(journal.statistics))),
    {
      ...(Bun.env["CANOPY_DESKTOP_DATA_DIR"] &&
        Bun.env["CANOPY_LOCAL_WORKER"] === "0" && {
          samplerOptions: desktopStorageOptions(
            Bun.env["CANOPY_DESKTOP_DATA_DIR"],
            Bun.env["CANOPY_DESKTOP_APP_PATH"],
            Bun.env["CANOPY_DESKTOP_UPDATE_CACHE"],
          ),
        }),
      ...(Bun.env["CANOPY_LOG_SUPERVISED"] !== "1" && { logDirectory }),
      worktreeRoots: worktreeRoots.managed,
      externalProviderHomes: [
        Bun.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"),
        Bun.env["CODEX_HOME"] || join(homedir(), ".codex"),
        Bun.env["GROK_HOME"] || join(homedir(), ".grok"),
        join(homedir(), ".agents"),
      ],
      additionalRoots: [
        { path: resolve(configPath), category: "application" },
        ...(installKind() === "binary"
          ? [
              { path: process.execPath, category: "application" as const },
              { path: process.execPath + ".bak", category: "application" as const },
            ]
          : []),
      ],
    },
  );

console.info(
  `worker ${local.worker_id} (Canopy ${CANOPY_VERSION}), gateway ${local.gateway_url}, data ${dataDir}, journal ${journalId}`,
);

// Turns and background tasks of a previous process died with it: turns are settled from their harness transcripts,
// tasks end as interrupted (sent after connecting).
const orphans = await host.recover();

if (orphans.turns + orphans.tasks > 0) {
  console.info(
    `closed ${orphans.turns} turn(s) (${orphans.fromTranscript} from the harness transcript) and ${orphans.tasks} background task(s) of the previous process`,
  );
}

const shutdown = new AbortController();

// Graceful stop (docs/durability.md, 3.3): announce DRAINING, stop providers and flush the journal
// before cancelling the link. A second signal aborts the network immediately; the supervisor bounds cleanup.
const stopping = new AbortController();
let currentLink: GatewayLink | undefined;
let gracefulStop: Promise<void> | undefined;
let restartExitCode: number | undefined;

function stopWorker(): Promise<void> {
  stopping.abort();
  desktopStatus("offline");

  // Cancel an in-flight handshake immediately; an established link stays up for journal acks.
  if (!currentLink) shutdown.abort();
  gracefulStop = (async () => {
    // Stop provider runtimes and journal their interrupted background tasks while the link is up.
    let tasks = 0;

    try {
      tasks = await host.shutdown();
    } catch (cause) {
      console.warn(`shutdown: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    if (currentLink && !(await host.flush(SHUTDOWN_FLUSH_MS).catch(() => false)))
      console.warn("shutdown: not every event reached the gateway; sent after the next start");

    if (tasks > 0) console.info(`stopped ${tasks} background task(s) for the shutdown`);

    try {
      currentLink?.close();
    } catch {
      // Link already closed.
    }

    // Do not wait for a remote peer to finish the half-close.
    shutdown.abort();
  })();

  return gracefulStop;
}

desktopDrain({
  idle: () => host.updateIdle(),
  online: () => !!currentLink,
  drain: (value) => {
    host.setUpdateDraining(value);

    if (!value) currentLink?.close();
  },
});

const releaseBaseUrl = process.env["CANOPY_RELEASE_BASE_URL"];
const binary = installKind() === "binary";

const updates = new WorkerUpdates({
  ...endpointOptions(local),
  credential: local.credential,
  workerId: local.worker_id,
  ...(releaseBaseUrl && { source: { baseUrl: releaseBaseUrl } }),
  deferStartupReport: binary,
  signal: stopping.signal,
  idle: () => host.updateIdle(),
  drain: (value) => {
    host.setUpdateDraining(value);

    if (value)
      currentLink?.send({
        case: "heartbeat",
        value: { runningTurns: host.runningTurns().length, state: WorkerState.DRAINING },
      });
    // A failed/deferred update must replay commands left unacknowledged while draining.
    else if (!stopping.signal.aborted) currentLink?.close();
  },
  log: (message) => console.info(message),
  restart: (exitCode = UPDATE_RESTART_EXIT_CODE) => {
    restartExitCode = exitCode;

    return gracefulStop ?? stopWorker();
  },
});

const networkRoute = new WorkerNetworkRoute({
  local,
  configPath,
  signal: stopping.signal,
  localWorker,
  changed: (endpoint) => updates.setEndpoint(endpointOptions(endpoint)),
});

const startup = binary ? new BinaryWorkerStartup(updates, (message) => console.info(message)) : undefined;
const updateLoop = updates.run();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping.signal.aborted) {
      shutdown.abort();

      return;
    }

    try {
      currentLink?.send({ case: "heartbeat", value: { runningTurns: 0, state: WorkerState.DRAINING } });
    } catch {
      // Link already closed.
    }

    void stopWorker();
  });
}

// Reconnect loop: exponential backoff with jitter, 1 s -> 60 s (docs/protocol.md).
// A Drain from the gateway replaces the backoff with the delay it asks for.
let backoffMs = 1_000;

while (!stopping.signal.aborted) {
  workerDiagnostics.record(110, 1);
  desktopStatus("connecting");
  let drainDelayMs: number | undefined;
  const endpoint = networkRoute.endpoint;

  try {
    const link = await openGatewayLink({
      heldThreads: await runtime.runPromise(Journal.use((journal) => journal.heldThreads())),
      ...endpointOptions(endpoint),
      credential: local.credential,
      pingIntervalMs: (local.ping_interval_seconds ?? 30) * 1_000,
      signal: shutdown.signal,
      hello: {
        workerId: local.worker_id,
        networkRouteStatus: networkRoute.status(),
        host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: WORKER_VERSION },
        state: host.updateDraining ? WorkerState.DRAINING : WorkerState.ACTIVE,
        capabilities: workerCapabilities({
          localWorker,
          fullAccess: local.full_access !== false,
        }),
        worktreesRoot: host.worktreesRoot,
        attachmentsRoot: host.attachmentsRoot,
        scratchRoot: join(dataDir, "scratch"),
        homeDirectory: homedir(),
        environmentKind: installKind() === "desktop" ? "desktop" : "server",
        runningTurns: host.runningTurns(),
        configVersion: host.config?.version ?? 0n,
        ...(await runtime.runPromise(journalHello())),
      },
    });

    if (startup) await startup.confirm(stopping.signal);

    if (stopping.signal.aborted) {
      link.close();
      break;
    }

    currentLink = link;

    if (link.heldThreads?.size)
      console.warn(
        `worker events deferred: count ${link.heldThreads.size} reason legacy_ingest_drain; update the gateway to resume delivery`,
      );
    workerDiagnostics.record(111, 1);

    desktopStatus("online");
    backoffMs = 1_000;

    const resent = await runtime.runPromise(
      resendPending(
        link,
        (event) => host.sendPreviews(link, event),
        (event) => host.canSendEvent(event),
      ),
    );

    console.info(
      `connected to ${networkRoute.endpoint.gateway_url}${resent > 0 ? `, resent ${resent} journal event(s)` : ""}`,
    );

    const heartbeat = setInterval(() => {
      desktopStatus("online");
      link.send({
        case: "heartbeat",
        value: {
          runningTurns: host.runningTurns().length,
          state: host.updateDraining ? WorkerState.DRAINING : WorkerState.ACTIVE,
        },
      });
    }, link.welcome.heartbeatIntervalSeconds * 1_000);

    try {
      startup?.ready();

      ({ drainDelayMs } = await serveLink(
        link,
        host,
        runtime,
        (m) => console.info(m),
        (routes) => networkRoute.offer(routes, link),
        logSource,
      ));

      if (endpoint !== networkRoute.endpoint) {
        workerDiagnostics.record(113, 1);
        drainDelayMs = 0;
      } else if (drainDelayMs !== undefined) workerDiagnostics.record(112, 1);
      else if (!stopping.signal.aborted) workerDiagnostics.record(114, 1);
    } finally {
      clearInterval(heartbeat);
      currentLink = undefined;
      desktopStatus("offline");
    }
  } catch (error) {
    if (shutdown.signal.aborted) break;

    // A reply queued on the old link can race its deliberate close after a successful migration.
    if (endpoint !== networkRoute.endpoint) {
      workerDiagnostics.record(113, 1);
      continue;
    }

    workerDiagnostics.record(
      error instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied].includes(error.code) ? 115 : 114,
      1,
    );

    if (networkRoute.failed()) continue;
    console.warn(`gateway link failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (stopping.signal.aborted) break;

  if (drainDelayMs !== undefined) {
    await sleep(drainDelayMs, undefined, { signal: stopping.signal }).catch(() => {});
  } else {
    await sleep(backoffMs * (0.5 + Math.random()), undefined, { signal: stopping.signal }).catch(() => {});
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}

// Stops provider runtimes, then closes the journal (SQLite) cleanly.
workerDiagnostics.stop();

await (gracefulStop ?? host.close());

shutdown.abort();

await updateLoop;

await runtime.dispose();

if (restartExitCode !== undefined) process.exit(restartExitCode);

if (process.connected) process.disconnect?.();
