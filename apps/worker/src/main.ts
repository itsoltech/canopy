import { hostname } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Result } from "effect";
import { WorkerState } from "@open-agents/contracts";
import { applyWorkerConfig, type AppliedConfig } from "./config/remote.ts";
import { defaultConfigPath, defaultDataDir, loadLocalConfig } from "./config/local.ts";
import { openGatewayLink, type GatewayLink } from "./gateway-link/index.ts";

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
console.info(`worker ${local.worker_id}, gateway ${local.gateway_url}, data ${join(dataDir)}`);

/** Last applied remote configuration. In memory only: it carries secrets (profile API keys). */
let config: AppliedConfig | undefined;

const shutdown = new AbortController();
// Graceful stop (docs/durability.md, 3.3): announce DRAINING and half-close the stream so the
// gateway sees a clean end. Running turns will finish or be interrupted here once SDK adapters land.
// A second signal, or the supervisor's hard deadline, aborts the stream immediately.
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
        host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: "0.0.0" },
        state: WorkerState.ACTIVE,
        capabilities: [],
        configVersion: config?.version ?? 0n,
      },
    });
    currentLink = link;
    backoffMs = 1_000;
    console.info(`connected to ${local.gateway_url}`);

    const heartbeat = setInterval(
      () => link.send({ case: "heartbeat", value: { runningTurns: 0, state: WorkerState.ACTIVE } }),
      link.welcome.heartbeatIntervalSeconds * 1_000,
    );
    try {
      for await (const message of link.messages) {
        switch (message.payload.case) {
          case "config": {
            const result = applyWorkerConfig(message.payload.value);
            if (result.applied) config = result.config;
            link.send({ case: "configApplied", value: result.report });
            const problems = result.report.issues ?? [];
            console.info(
              `config v${message.payload.value.version} ${result.applied ? "applied" : "rejected"}` +
                (problems.length > 0 ? ` (${problems.length} issue(s))` : ""),
            );
            break;
          }
          case "command":
            // Session handling (SDK adapters) is the next milestone; for now commands are rejected explicitly.
            link.send({
              case: "commandResult",
              value: {
                commandId: message.payload.value.commandId,
                ok: false,
                errorCode: config ? "UNIMPLEMENTED" : "WORKER_NOT_CONFIGURED",
              },
            });
            break;
          case "drain":
            drainDelayMs = message.payload.value.reconnectAfterMs;
            console.info(`gateway draining (${message.payload.value.reason}), reconnecting in ${drainDelayMs} ms`);
            break;
          default:
            break;
        }
      }
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
