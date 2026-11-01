import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ManagedRuntime, Result } from "effect";
import { WorkerState } from "@open-agents/contracts";
import { defaultConfigPath, defaultDataDir, loadLocalConfig } from "./config/local.ts";
import { journalHello, openGatewayLink, resendPending, type GatewayLink } from "./gateway-link/index.ts";
import { Journal } from "./journal/index.ts";
import { serveLink, WorkerHost } from "./runtime/index.ts";

const WORKER_VERSION = "0.0.0";

// Local config is only how to reach the gateway; everything else arrives as WorkerConfig.
const configPath = defaultConfigPath(Bun.env, process.platform);
const loaded = await loadLocalConfig(configPath, process.platform);
if (Result.isFailure(loaded)) {
  console.error(loaded.failure);
  process.exit(78); // EX_CONFIG: the supervisor should not restart in a loop
}
const local = loaded.success;
const dataDir = local.data_dir ?? defaultDataDir(Bun.env, process.platform);
const ca = local.ca_file ? readFileSync(local.ca_file) : undefined;
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

// Durable outbox: every thread event goes through the journal before it is sent (docs/durability.md, 3.1).
const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
const { journalId } = await runtime.runPromise(journalHello());
const host = new WorkerHost({ runtime, dataDir, clientVersion: WORKER_VERSION, log: (m) => console.info(m) });
console.info(`worker ${local.worker_id}, gateway ${local.gateway_url}, data ${dataDir}, journal ${journalId}`);
// Turns and background tasks of a previous process died with it: they end as interrupted (sent after connecting).
const orphans = await host.recover();
if (orphans.turns + orphans.tasks > 0) console.info(`closed ${orphans.turns} turn(s) and ${orphans.tasks} background task(s) of the previous process`);

const shutdown = new AbortController();
// Graceful stop (docs/durability.md, 3.3): announce DRAINING and half-close the stream so the
// gateway sees a clean end. A second signal, or the supervisor's hard deadline, aborts immediately.
const stopping = new AbortController();
let currentLink: GatewayLink | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping.signal.aborted) {
      shutdown.abort();
      return;
    }
    stopping.abort();
    try {
      currentLink?.send({ case: "heartbeat", value: { runningTurns: 0, state: WorkerState.DRAINING } });
      currentLink?.close();
    } catch {
      // Link already closed; nothing to drain.
    }
    if (!currentLink) shutdown.abort();
  });
}

// Reconnect loop: exponential backoff with jitter, 1 s -> 60 s (docs/protocol.md).
// A Drain from the gateway replaces the backoff with the delay it asks for.
let backoffMs = 1_000;
while (!stopping.signal.aborted) {
  let drainDelayMs: number | undefined;
  try {
    const link = await openGatewayLink({
      baseUrl: local.gateway_url,
      credential: local.credential,
      pingIntervalMs: (local.ping_interval_seconds ?? 30) * 1_000,
      signal: shutdown.signal,
      ...(ca && { ca }),
      hello: {
        workerId: local.worker_id,
        host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: WORKER_VERSION },
        state: WorkerState.ACTIVE,
        // running_turns: the list below is complete, the gateway ends its other running turns of this worker.
        capabilities: ["running_turns"],
        runningTurns: host.runningTurns(),
        configVersion: host.config?.version ?? 0n,
        ...(await runtime.runPromise(journalHello())),
      },
    });
    currentLink = link;
    backoffMs = 1_000;
    const resent = await runtime.runPromise(resendPending(link));
    console.info(`connected to ${local.gateway_url}${resent > 0 ? `, resent ${resent} journal event(s)` : ""}`);
    const heartbeat = setInterval(
      () => link.send({ case: "heartbeat", value: { runningTurns: host.runningTurns().length, state: WorkerState.ACTIVE } }),
      link.welcome.heartbeatIntervalSeconds * 1_000,
    );
    try {
      ({ drainDelayMs } = await serveLink(link, host, runtime, (m) => console.info(m)));
    } finally {
      clearInterval(heartbeat);
      currentLink = undefined;
    }
  } catch (error) {
    if (shutdown.signal.aborted) break;
    console.warn(`gateway link failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stopping.signal.aborted) break;
  if (drainDelayMs !== undefined) {
    await Bun.sleep(drainDelayMs);
  } else {
    await Bun.sleep(backoffMs * (0.5 + Math.random()));
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}

// Stops provider runtimes, then closes the journal (SQLite) cleanly.
await host.close();
await runtime.dispose();
