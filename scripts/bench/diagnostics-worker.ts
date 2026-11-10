import { openGatewayLink } from "../../apps/worker/src/gateway-link/link.ts";
import { WorkerState } from "@canopy/contracts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Schema } from "effect";
import { BenchCommand } from "./diagnostics-protocol.ts";

const baseUrl = process.env["CANOPY_BENCH_GATEWAY_URL"];
const credential = process.env["CANOPY_BENCH_WORKER_CREDENTIAL"];
const workerId = process.env["CANOPY_BENCH_WORKER_ID"];

if (!baseUrl || !credential || !workerId) throw new Error("Private benchmark worker configuration is required");

const connect = () =>
  openGatewayLink({
    baseUrl,
    credential,
    hello: { workerId, journalId: crypto.randomUUID(), state: WorkerState.ACTIVE, capabilities: ["diagnostics_v1"] },
  });

let link = await connect();
let reconnect = false;
let stopping = false;

const heartbeat = setInterval(() => link.send({ case: "heartbeat", value: { state: WorkerState.ACTIVE } }), 15_000);

const lag = monitorEventLoopDelay({ resolution: 20 });
let cpu = process.cpuUsage();
let since = performance.now();

process.on("message", (message: BenchCommand) => {
  const command = Schema.decodeUnknownSync(BenchCommand)(message);

  if (command.action === "begin") {
    lag.reset();
    lag.enable();
    cpu = process.cpuUsage();
    since = performance.now();
  }

  const used = process.cpuUsage(cpu);
  const memory = process.memoryUsage();
  process.send?.({
    id: command.id,
    stats: {
      cpuMicros: used.user + used.system,
      elapsedMs: performance.now() - since,
      rss: memory.rss,
      heap: memory.heapUsed,
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
    },
  });

  if (command.action === "end") lag.disable();

  if (command.action === "reconnect") {
    reconnect = true;
    link.close();
  }

  if (command.action === "stop") {
    stopping = true;
    clearInterval(heartbeat);
    link.close();
  }
});

process.send?.({ id: 0 });

try {
  while (!stopping) {
    for await (const { payload } of link.messages) {
      if (payload.case === "config")
        link.send({ case: "configApplied", value: { version: payload.value.version, applied: true } });

      if (payload.case === "command")
        link.send({ case: "commandResult", value: { commandId: payload.value.commandId, ok: true } });
    }

    if (!reconnect || stopping) break;
    reconnect = false;
    link = await connect();
  }
} finally {
  clearInterval(heartbeat);
  lag.disable();
  process.disconnect?.();
}
