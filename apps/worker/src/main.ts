import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { WorkerState } from "@open-agents/contracts";
import { openGatewayLink, type GatewayLink } from "./gateway-link/index.ts";
import { resolveProfiles, toHelloProfile, type ProviderProfileConfig } from "./providers/index.ts";

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const baseUrl = requireEnv("OA_GATEWAY_URL");
const workerId = requireEnv("OA_WORKER_ID");
const credential = requireEnv("OA_WORKER_CREDENTIAL");
const caFile = Bun.env["OA_GATEWAY_CA"];
const shutdown = new AbortController();

// Temporary until the worker config file lands: one optional CLIProxyAPI profile from env.
const cliProxyUrl = Bun.env["OA_CLIPROXYAPI_URL"];
const profileConfigs: ProviderProfileConfig[] = cliProxyUrl
  ? [{ kind: "cliproxyapi", id: "cliproxyapi", baseUrl: cliProxyUrl, apiKeyEnv: "OA_CLIPROXYAPI_API_KEY" }]
  : [];
const profiles = resolveProfiles(profileConfigs, Bun.env);
for (const { config, problem } of profiles) {
  if (problem) console.warn(`provider profile ${config.id} unavailable: ${problem}`);
}

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
      baseUrl,
      credential,
      pingIntervalMs: 30_000,
      signal: shutdown.signal,
      ...(caFile && { ca: readFileSync(caFile) }),
      hello: {
        workerId,
        host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: "0.0.0" },
        profiles: profiles.map(toHelloProfile),
        state: WorkerState.ACTIVE,
        capabilities: [],
      },
    });
    currentLink = link;
    backoffMs = 1_000;
    console.info(`connected to ${baseUrl}`);

    const heartbeat = setInterval(
      () => link.send({ case: "heartbeat", value: { runningTurns: 0, state: WorkerState.ACTIVE } }),
      link.welcome.heartbeatIntervalSeconds * 1_000,
    );
    try {
      // Session handling (SDK adapters) is the next milestone; for now commands are rejected explicitly.
      for await (const message of link.messages) {
        if (message.payload.case === "command") {
          link.send({
            case: "commandResult",
            value: { commandId: message.payload.value.commandId, ok: false, errorCode: "UNIMPLEMENTED" },
          });
        } else if (message.payload.case === "drain") {
          drainDelayMs = message.payload.value.reconnectAfterMs;
          console.info(`gateway draining (${message.payload.value.reason}), reconnecting in ${drainDelayMs} ms`);
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
