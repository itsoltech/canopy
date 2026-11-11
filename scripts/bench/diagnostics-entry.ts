import { monitorEventLoopDelay } from "node:perf_hooks";
import { Schema, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startGrpcServer } from "@canopy/transport";
import { GatewayCore } from "../../apps/gateway/src/core/core.ts";
import { serviceTokenAuth, uiRoutes } from "../../apps/gateway/src/api/index.ts";
import { workerRoutes } from "../../apps/gateway/src/worker-link/routes.ts";
import { gatewayRuntime, ensureDevUser } from "../../apps/gateway/src/runtime.ts";
import { DatabaseMaintenance } from "../../apps/gateway/src/maintenance/job.ts";
import { BenchCommand } from "./diagnostics-protocol.ts";
import { DiagnosticsGovernorWorkload } from "./diagnostics-governor.ts";

const gatewayDiagnosticsEnabled =
  process.env["CANOPY_BENCH_STAGE"] === "2" && process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1";

const runtime = gatewayRuntime(process.env, { databaseDiagnostics: gatewayDiagnosticsEnabled });
const owner = await ensureDevUser(runtime, "dev@localhost");

const core = new GatewayCore({
  runtime,
  userId: owner,
  instanceId: "diagnostics-benchmark",
  role: "server",
  diagnosticsEnabled: process.env["CANOPY_BENCH_STAGE"] === "2" || process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1",
  gatewayDiagnosticsEnabled,
});

const governorWorkload = new DiagnosticsGovernorWorkload();

const token = process.env["CANOPY_UI_SERVICE_TOKEN"];

if (!token) throw new Error("Benchmark service token is required");

const server = await startGrpcServer({
  host: "127.0.0.1",
  port: Number(process.env["CANOPY_PORT"]),
  routes: (router) => {
    workerRoutes(core, router);
    uiRoutes(core)(router);
  },
  interceptors: [core.diagnostics.interceptor, serviceTokenAuth(token, core.mobile)],
});

const restoredAt = performance.now();
const restoreCpu = process.cpuUsage();

await core.diagnostics.start();

const restoreMs = performance.now() - restoredAt;
const restoredCpu = process.cpuUsage(restoreCpu);
const restoreCpuMicros = restoredCpu.user + restoredCpu.system;
let backgroundRestoreMs = 0;
let backgroundRestoreCpuMicros = 0;
let postRestorePeakRss = 0;

void core.diagnostics.persistence?.start().then(async () => {
  backgroundRestoreMs = performance.now() - restoredAt;
  const cpu = process.cpuUsage(restoreCpu);
  backgroundRestoreCpuMicros = cpu.user + cpu.system;
  postRestorePeakRss = Number((await Bun.file("/proc/self/status").text()).match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
});

// Linux rusage can include memory inherited before exec; VmHWM belongs to this process image.
const startupPeakRss =
  process.platform === "linux"
    ? Number((await Bun.file("/proc/self/status").text()).match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024
    : process.resourceUsage().maxRSS * 1024;

if (!startupPeakRss) throw new Error("Startup RSS high-water mark unavailable");

const maintenance = new DatabaseMaintenance(runtime, owner);

maintenance.start();

const lag = monitorEventLoopDelay({ resolution: 20 });
let cpu = process.cpuUsage();
let since = performance.now();
let done!: () => void;

const stopped = new Promise<void>((resolve) => {
  done = resolve;
});

async function stats() {
  const elapsedMs = performance.now() - since;
  const used = process.cpuUsage(cpu);
  const memory = process.memoryUsage();

  const db = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (yield* sql<{
        wal: string;
        bytes: string;
        rows: string;
        writes: string;
        table_bytes: string;
        index_bytes: string;
        dead_tuples: string;
        autovacuums: string;
      }>`SELECT
      (SELECT wal_bytes::text FROM pg_stat_wal) AS wal,
      (SELECT coalesce(sum(octet_length(payload)),0)::text FROM diagnostics_rollups) AS bytes,
      (SELECT count(*)::text FROM diagnostics_rollups) AS rows,
      (SELECT coalesce(sum(n_tup_ins+n_tup_upd),0)::text FROM pg_stat_user_tables WHERE relname LIKE 'diagnostics_%') AS writes,
      (SELECT coalesce(sum(pg_table_size(relid)),0)::text FROM pg_stat_user_tables WHERE relname LIKE 'diagnostics_%') AS table_bytes,
      (SELECT coalesce(sum(pg_indexes_size(relid)),0)::text FROM pg_stat_user_tables WHERE relname LIKE 'diagnostics_%') AS index_bytes,
      (SELECT coalesce(sum(n_dead_tup),0)::text FROM pg_stat_user_tables WHERE relname LIKE 'diagnostics_%') AS dead_tuples,
      (SELECT coalesce(sum(autovacuum_count),0)::text FROM pg_stat_user_tables WHERE relname LIKE 'diagnostics_%') AS autovacuums`)[0]!;
    }),
  );

  return {
    cpuMicros: used.user + used.system,
    elapsedMs,
    rss: memory.rss,
    heap: memory.heapUsed,
    eventLoopP99Ms: lag.percentile(99) / 1e6,
    eventLoopMaxMs: lag.max / 1e6,
    walBytes: Number(db.wal),
    rollupBytes: Number(db.bytes),
    rows: Number(db.rows),
    writes: Number(db.writes),
    allocatedBytes: core.diagnostics.collector.budget.used + core.diagnostics.linkBudget.used,
    dropped: core.diagnostics.collector.budget.dropped + core.diagnostics.linkBudget.dropped,
    restoreMs,
    restoreCpuMicros,
    startupPeakRss,
    backgroundRestoreMs,
    backgroundRestoreCpuMicros,
    postRestorePeakRss,
    allocatedSeries: [
      core.diagnostics.collector.short,
      core.diagnostics.collector.minutes,
      core.diagnostics.collector.historyMinutes,
    ].reduce(
      (count, ring) =>
        count + ring.slots.reduce((total, slot) => total + (slot?.series.size ?? 0) + (slot?.measures?.size ?? 0), 0),
      0,
    ),
    tableBytes: Number(db.table_bytes),
    indexBytes: Number(db.index_bytes),
    deadTuples: Number(db.dead_tuples),
    autovacuumCount: Number(db.autovacuums),
  };
}

async function execute(command: BenchCommand) {
  if (command.action === "governor") governorWorkload.start();

  if (command.action === "end" || command.action === "stop") await governorWorkload.stop();

  if (command.action === "gc") {
    if (process.env["CANOPY_BENCH_RESOURCES"] !== "1") throw new Error("GC is resource-only");
    Bun.gc(true);
  }

  if (command.action === "begin") {
    lag.reset();
    lag.enable();
    cpu = process.cpuUsage();
    since = performance.now();
  }

  const value = await stats();

  if (command.action === "end") lag.disable();

  if (command.action === "end" && governorWorkload.started)
    console.error(
      JSON.stringify({
        phase: "governor_workload",
        started: governorWorkload.started,
        failed: governorWorkload.failed,
      }),
    );
  process.send?.({ id: command.id, stats: value, error: false });

  if (command.action === "stop") done();
}

process.on("message", (message: BenchCommand) => {
  const command = Schema.decodeUnknownSync(BenchCommand)(message);
  void execute(command).catch(() => process.send?.({ id: command.id, error: true }));
});

process.send?.({ id: 0, error: false });

try {
  await stopped;
} finally {
  lag.disable();
  await maintenance.stop();
  await core.link.shutdown();
  await core.diagnostics.stop();
  core.secrets.stop();
  core.desktopControl.close();
  core.appControl.close();
  core.updates.close();
  await server.close();
  await runtime.dispose();
  process.disconnect?.();
}
