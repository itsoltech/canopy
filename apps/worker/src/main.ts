import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { ManagedRuntime, Result } from "effect";
import { WorkerState } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { STEER_ATTACHMENTS_CAPABILITY } from "@canopy/domain/release/protocol";
import { defaultConfigPath, defaultDataDir, loadLocalConfig } from "./config/local.ts";
import { resolveWorktreeRoots, type WorktreeRoots } from "./git/worktree-roots.ts";
import { journalHello, openGatewayLink, resendPending, type GatewayLink } from "./gateway-link/index.ts";
import { Journal } from "./journal/index.ts";
import { serveLink, WorkerHost } from "./runtime/index.ts";
import { enrollWorker, workerCommand, workerServiceSnippet } from "./enroll.ts";
import { desktopDrain, desktopStatus, workerOnline } from "./desktop-status.ts";
import {
  confirmStartup,
  installKind,
  onSupervisorHandover,
  superviseBinary,
  UPDATE_RESTART_EXIT_CODE,
} from "@canopy/updater";
import { WorkerUpdates } from "./update-link.ts";
import { applyShellEnv } from "./cli-tools/shell-env.ts";
import { endpointOptions, WorkerNetworkRoute } from "./network-route.ts";

const cliArgs = Bun.argv.slice(2);

if (cliArgs.includes("--version")) {
  console.info(CANOPY_VERSION);
  process.exit(0);
}

// Docker HEALTHCHECK: healthy while the link to the gateway is up (needs CANOPY_WORKER_STATUS_FILE, see desktop-status.ts).
if (cliArgs[0] === "healthcheck") process.exit(workerOnline(Bun.env) ? 0 : 1);

if (cliArgs[0] === "run") cliArgs.shift();

const command = cliArgs[0] === "enroll" || cliArgs[0] === "service" ? cliArgs.shift() : "start";
let cli;

// Bind each option to its value: an enrollment token may start with "-", which parseArgs would read as a flag.
const valueOptions = new Set(["--gateway", "--token", "--config", "--data-dir", "--fingerprint"]);
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
      token: { type: "string" },
      config: { type: "string" },
      "data-dir": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
  }).values;
} catch {
  console.error(
    "Usage: canopy-worker enroll --gateway URL --token TOKEN [--config PATH] [--data-dir DIR] [--force]\n       canopy-worker [--config PATH]\n       canopy-worker service [--config PATH]",
  );
  process.exit(64);
}

const configPath = cli.config ?? defaultConfigPath(Bun.env, process.platform);

// What to type to run this worker: the standalone binary, or Bun with the source entry from the repository root.
const self = workerCommand().length === 1 ? process.execPath : "bun apps/worker/src/main.ts";

if (cli.help) {
  console.info(
    `Canopy worker ${CANOPY_VERSION}\nEnroll: ${self} enroll --gateway URL --token TOKEN [--config PATH] [--data-dir DIR] [--force]\nStart: ${self} [--config PATH]\nService: ${self} service [--config PATH]\nVersion: ${self} --version`,
  );
  process.exit(0);
}

if (command === "enroll") {
  if (!cli.gateway || !cli.token) {
    console.error("--gateway and --token are required");
    process.exit(64);
  }

  try {
    await enrollWorker({
      gateway: cli.gateway,
      ...(cli.fingerprint && { fingerprint: cli.fingerprint }),
      token: cli.token,
      configPath,
      ...(cli["data-dir"] && { dataDir: cli["data-dir"] }),
      ...(cli.force && { force: true }),
    });
    const pathArg = `'${resolve(configPath).replaceAll("'", `'"'"'`)}'`;
    console.info(
      `Enrolled. Config saved with mode 0600: ${resolve(configPath)}\nStart: ${self} --config ${pathArg}\nFor a user service: ${self} service --config ${pathArg}`,
    );
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Enrollment failed");
    process.exit(78);
  }
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

// The user's login-shell PATH (bun, Volta, nvm, …) for CLI discovery and harnesses; discovery waits for it.
if (installKind() !== "docker") void applyShellEnv();

const dataDir = resolve(local.data_dir ?? defaultDataDir(Bun.env, process.platform));

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

// Durable outbox: every thread event goes through the journal before it is sent (docs/durability.md, 3.1).
const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
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

const host = new WorkerHost({
  runtime,
  dataDir,
  clientVersion: WORKER_VERSION,
  worktreeRoots,
  log: (m) => console.info(m),
  fullAccess: local.full_access !== false,
});

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

desktopDrain({
  idle: () => host.updateIdle(),
  online: () => !!currentLink,
  drain: (value) => {
    host.setUpdateDraining(value);

    if (!value) currentLink?.close();
  },
});

const updates = new WorkerUpdates({
  ...endpointOptions(local),
  credential: local.credential,
  workerId: local.worker_id,
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
  restart: async (exitCode = UPDATE_RESTART_EXIT_CODE) => {
    stopping.abort();
    await host.shutdown();
    await host.flush(SHUTDOWN_FLUSH_MS).catch(() => false);
    currentLink?.close();
    shutdown.abort();
    await runtime.dispose();
    process.exit(exitCode);
  },
});

const networkRoute = new WorkerNetworkRoute({
  local,
  configPath,
  signal: stopping.signal,
  localWorker: Bun.env["CANOPY_LOCAL_WORKER"] === "1",
  changed: (endpoint) => updates.setEndpoint(endpointOptions(endpoint)),
});

if (installKind() === "binary")
  onSupervisorHandover(
    () => updates.handover(),
    (message) => console.info(message),
  );

const updateLoop = updates.run();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping.signal.aborted) {
      shutdown.abort();

      return;
    }

    stopping.abort();
    desktopStatus("offline");

    // Cancel an in-flight handshake immediately; an established link stays up for journal acks.
    if (!currentLink) shutdown.abort();
    gracefulStop = (async () => {
      try {
        currentLink?.send({ case: "heartbeat", value: { runningTurns: 0, state: WorkerState.DRAINING } });
      } catch {
        // Link already closed.
      }

      // Background tasks die with the provider runtimes: recorded as stopped by the shutdown (with their end time) and
      // reported while the link is up, so the gateway can tell their agents (docs/execution.md, "Pobudka").
      const tasks = await host
        .shutdown()
        .catch(
          (cause: unknown) => (console.warn(`shutdown: ${cause instanceof Error ? cause.message : String(cause)}`), 0),
        );

      if (currentLink && !(await host.flush(SHUTDOWN_FLUSH_MS).catch(() => false)))
        console.warn("shutdown: not every event reached the gateway; sent after the next start");

      if (tasks > 0) console.info(`stopped ${tasks} background task(s) for the shutdown`);

      try {
        currentLink?.close();
      } catch {
        // Link already closed; nothing to drain.
      }

      // The bounded flush is complete. Do not wait for a remote peer to finish the half-close.
      shutdown.abort();
    })();
  });
}

// Reconnect loop: exponential backoff with jitter, 1 s -> 60 s (docs/protocol.md).
// A Drain from the gateway replaces the backoff with the delay it asks for.
let backoffMs = 1_000;

while (!stopping.signal.aborted) {
  desktopStatus("connecting");
  let drainDelayMs: number | undefined;
  const endpoint = networkRoute.endpoint;

  try {
    const link = await openGatewayLink({
      ...endpointOptions(endpoint),
      credential: local.credential,
      pingIntervalMs: (local.ping_interval_seconds ?? 30) * 1_000,
      signal: shutdown.signal,
      hello: {
        workerId: local.worker_id,
        networkRouteStatus: networkRoute.status(),
        host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: WORKER_VERSION },
        state: host.updateDraining ? WorkerState.DRAINING : WorkerState.ACTIVE,
        // running_turns: the list below is complete, the gateway ends its other running turns of this worker.
        // probe_providers, codex_device_login: provider instances are checked again and sign in from the app.
        // attachments: turns may carry files (fetched with FetchBlob into attachments_root).
        // cli_install: provider CLIs are reported (CliToolsReport) and installed on demand (InstallCli).
        // worktrees: git refs and worktrees of workspaces (docs/worktrees.md), under worktrees_root by default.
        // project_sources: new project directories (git init) and clones (InitRepository, CloneRepository).
        capabilities: [
          "shell_input_v1",
          "provider_account_status",
          "running_turns",
          "attachments",
          STEER_ATTACHMENTS_CAPABILITY,
          "probe_providers",
          "codex_device_login",
          "generate_text",
          "bot_harness_v1",
          "bot_images_v1",
          "bot_files_v1",
          "thread_secrets",
          "cli_install",
          // desktop_bundled: the desktop app's own local-mode worker, updated with the app (docs/updates.md).
          ...(Bun.env["CANOPY_LOCAL_WORKER"] === "1" ? ["desktop_bundled"] : ["network_route_migration"]),
          "agent_environment_v1",
          "agent_skills_v1",
          "agent_plugins_v1",
          "worktrees",
          "workspace_origin",
          "workspace_clone_source",
          "worktree_lifecycle",
          "git_worktree_discovery",
          // git_heads: the live branch of thread checkouts (GitHeads).
          "git_heads",
          "git_branch_switch_v1",
          // reveal_path: RevealPath opens a thread's directory in this computer's file manager.
          "reveal_path",
          // provisional_branches: RenameWorktreeBranch.provisional keeps pushed or switched branches.
          "provisional_branches",
          "project_sources",
          "workspace_copy_v1",
          // cli_import_v1: Settings → Import reads the device's CLI homes on request (docs/import.md).
          "cli_import_v1",
          // cli_import_library_v1: the scan also lists settings and library items, and reads them on request.
          "cli_import_library_v1",
          // full_access: PERMISSION_MODE_FULL_ACCESS runs unsandboxed; not announced when worker.json turns it off.
          ...(local.full_access === false ? [] : ["full_access"]),
        ],
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

    currentLink = link;

    if (installKind() === "binary") await confirmStartup();
    desktopStatus("online");
    backoffMs = 1_000;
    const resent = await runtime.runPromise(resendPending(link, (event) => host.sendPreviews(link, event)));
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
      ({ drainDelayMs } = await serveLink(
        link,
        host,
        runtime,
        (m) => console.info(m),
        (routes) => networkRoute.offer(routes, link),
      ));

      if (endpoint !== networkRoute.endpoint) drainDelayMs = 0;
    } finally {
      clearInterval(heartbeat);
      currentLink = undefined;
      desktopStatus("offline");
    }
  } catch (error) {
    if (shutdown.signal.aborted) break;

    // A reply queued on the old link can race its deliberate close after a successful migration.
    if (endpoint !== networkRoute.endpoint) continue;

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
await gracefulStop;

await host.close();

shutdown.abort();

await updateLoop;

await runtime.dispose();

if (process.connected) process.disconnect?.();
