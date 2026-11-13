import { openGatewayLink } from "../../apps/worker/src/gateway-link/link.ts";
import { WorkerState } from "@canopy/contracts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Schema } from "effect";
import { BenchCommand } from "./diagnostics-protocol.ts";
import { DiagnosticsWorkerWorkload } from "./diagnostics-worker-workload.ts";
import { workerDiagnostics } from "../../apps/worker/src/diagnostics/worker.ts";
import { workerTracing } from "../../apps/worker/src/diagnostics/tracing.ts";

const baseUrl = process.env["CANOPY_BENCH_GATEWAY_URL"];
const credential = process.env["CANOPY_BENCH_WORKER_CREDENTIAL"];
const workerId = process.env["CANOPY_BENCH_WORKER_ID"];

if (!baseUrl || !credential || !workerId) throw new Error("Private benchmark worker configuration is required");

const workload = ["3", "4", "5", "6"].includes(process.env["CANOPY_BENCH_STAGE"] ?? "")
  ? new DiagnosticsWorkerWorkload()
  : undefined;

await workload?.start();

const connect = async () => {
  const link = await openGatewayLink({
    baseUrl,
    credential,
    hello: {
      workerId,
      journalId: crypto.randomUUID(),
      ...(await workload?.hello()),
      state: WorkerState.ACTIVE,
      capabilities: ["diagnostics_v1", "diagnostics_trace_v1", ...(workload ? ["worker_diagnostics_v1"] : [])],
    },
  });

  await workload?.connected(link);

  return link;
};

let link = await connect();
let reconnect = false;
let stopping = false;

const heartbeat = setInterval(() => link.send({ case: "heartbeat", value: { state: WorkerState.ACTIVE } }), 15_000);

const lag = monitorEventLoopDelay({ resolution: 20 });
let cpu = process.cpuUsage();
let since = performance.now();

async function execute(command: BenchCommand) {
  if (command.action === "end" || command.action === "stop") await workload?.end();

  if (command.action === "begin") {
    lag.reset();
    lag.enable();
    cpu = process.cpuUsage();
    since = performance.now();
    workload?.begin(command.phase ?? "idle");
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
    workerDiagnostics.record(113, 1);
    reconnect = true;
    link.close();
  }

  if (command.action === "stop") {
    stopping = true;
    clearInterval(heartbeat);
    link.close();
  }
}

process.on("message", (message: BenchCommand) => {
  void execute(Schema.decodeUnknownSync(BenchCommand)(message)).catch(() => {
    console.error("Benchmark worker command failed");
    process.exit(1);
  });
});

process.send?.({ id: 0 });

try {
  while (!stopping) {
    for await (const { payload } of link.messages) {
      if (payload.case === "diagnosticsTraceCommand")
        link.send({ case: "diagnosticsTraceReply", value: workerTracing.receive(payload.value) });

      if (payload.case === "config")
        link.send({ case: "configApplied", value: { version: payload.value.version, applied: true } });

      if (payload.case === "command")
        link.send({ case: "commandResult", value: { commandId: payload.value.commandId, ok: true } });

      if (payload.case === "eventAck") await workload?.ack(payload.value.threadId, payload.value.ackSeq);
    }

    if (!reconnect || stopping) break;
    reconnect = false;
    link = await connect();
  }
} finally {
  workerTracing.close();
  clearInterval(heartbeat);
  lag.disable();
  await workload?.close();
  process.disconnect?.();
}
