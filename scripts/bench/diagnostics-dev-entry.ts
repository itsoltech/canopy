/** Copy with protocol/forensics into an isolated dev checkout; all product imports below are relative to it. */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Schema } from "effect";
import { startGrpcServer } from "@canopy/transport";
import { GatewayCore } from "../../apps/gateway/src/core/core.ts";
import { serviceTokenAuth, uiRoutes } from "../../apps/gateway/src/api/index.ts";
import { workerRoutes } from "../../apps/gateway/src/worker-link/routes.ts";
import { gatewayRuntime, ensureDevUser } from "../../apps/gateway/src/runtime.ts";
import { BenchCommand, BenchStats } from "./diagnostics-protocol.ts";
import { DiagnosticsForensics } from "./diagnostics-forensics.ts";

const runtime = gatewayRuntime(process.env, { databaseDiagnostics: false });
const owner = await ensureDevUser(runtime, "dev@localhost");

const core = new GatewayCore({
  runtime,
  userId: owner,
  instanceId: "diagnostics-dev-control",
  role: "server",
  diagnosticsEnabled: false,
  gatewayDiagnosticsEnabled: false,
});

const token = process.env["CANOPY_UI_SERVICE_TOKEN"];

if (!token) throw new Error("Private fixture token required");

const server = await startGrpcServer({
  host: "127.0.0.1",
  port: Number(process.env["CANOPY_PORT"]),
  routes: (router) => {
    workerRoutes(core, router);
    uiRoutes(core)(router);
  },
  interceptors: [serviceTokenAuth(token, core.mobile)],
});

const lag = monitorEventLoopDelay({ resolution: 20 });
const forensics = new DiagnosticsForensics();
let cpu = process.cpuUsage();
let since = performance.now();
let done!: () => void;

const stopped = new Promise<void>((resolve) => {
  done = resolve;
});

process.on("message", async (message: BenchCommand) => {
  const command = Schema.decodeUnknownSync(BenchCommand)(message);

  try {
    if (command.action === "begin") {
      cpu = process.cpuUsage();
      since = performance.now();
      lag.reset();
      lag.enable();
      forensics.begin(command.phase);
    }

    if (command.action === "heap") await forensics.heap(command.phase);

    if (command.action === "gc") Bun.gc(true);
    const used = process.cpuUsage(cpu);
    const memory = process.memoryUsage();

    const stats = Schema.decodeUnknownSync(BenchStats)({
      ...Object.fromEntries(Object.keys(BenchStats.fields).map((key) => [key, 0])),
      cpuMicros: used.user + used.system,
      elapsedMs: performance.now() - since,
      rss: memory.rss,
      heap: memory.heapUsed,
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
    });

    if (command.action === "end") {
      lag.disable();
      await forensics.end();
    }

    process.send?.({ id: command.id, stats, error: false });

    if (command.action === "stop") done();
  } catch {
    process.send?.({ id: command.id, error: true });
  }
});

process.send?.({ id: 0, error: false });

try {
  await stopped;
} finally {
  lag.disable();
  core.secrets.stop();
  core.desktopControl.close();
  core.appControl.close();
  core.updates.close();
  await server.close();
  await runtime.dispose();
}
