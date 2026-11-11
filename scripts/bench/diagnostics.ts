import { randomBytes } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { diagnosticsProcess } from "./diagnostics-process.ts";
import { seedClient } from "./seed-client.ts";
import { diagnosticsWorker } from "./diagnostics-worker-process.ts";
import { seedDiagnosticsHistory } from "./seed-diagnostics-history.ts";
import { diagnosticsLoad, type DiagnosticsPhase } from "./diagnostics-load.ts";
import { diagnosticsContention } from "./diagnostics-contention.ts";
import { monitorHost } from "./diagnostics-host.ts";
import { diagnosticsStorage, diagnosticsWrites } from "./diagnostics-storage.ts";

/** Isolated PostgreSQL and alternating AB/BA pairs; host noise invalidates the entire pair. */
const forbidden = new Set([17443, 5180, 8444, 17444, 17445, 3000, 7443, 7432, 4443, 7444, 5291, 8081]);
const pgPort = Number(process.env["CANOPY_BENCH_PG_PORT"] ?? 18191);
const gatewayPort = Number(process.env["CANOPY_BENCH_GATEWAY_PORT"] ?? 18192);

if (
  [pgPort, gatewayPort].some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || forbidden.has(port)) ||
  pgPort === gatewayPort
)
  throw new Error("Choose distinct unused non-reserved benchmark ports");

const idleMs = Number(process.env["CANOPY_BENCH_IDLE_MS"] ?? 600_000);
const loadMs = Number(process.env["CANOPY_BENCH_LOAD_MS"] ?? 120_000);
const series = Number(process.env["CANOPY_BENCH_SERIES"] ?? 5);
const short = process.env["CANOPY_BENCH_STAGE"] === "2" && process.env["CANOPY_BENCH_SHORT"] === "1";
const minimumContentionMs = short ? 90_000 : 140_000;

if (
  (process.env["CANOPY_BENCH_CONTENTION"] === "1" || process.env["CANOPY_BENCH_ALL_PHASES"] === "1") &&
  loadMs < minimumContentionMs
)
  throw new Error(`Contention phases need at least ${minimumContentionMs / 1000} seconds`);

const name = `canopy-diagnostics-bench-${process.pid}`;
const password = randomBytes(24).toString("hex");
const token = randomBytes(32).toString("hex");
const key = randomBytes(32).toString("base64");
let active: Awaited<ReturnType<typeof diagnosticsProcess>> | undefined;
let worker: Awaited<ReturnType<typeof diagnosticsWorker>> | undefined;
let attempt = 0;
let host: Awaited<ReturnType<typeof monitorHost>> | undefined;
const shutdown = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => shutdown.abort(new Error("Benchmark stopped by its owner")));

function assertRunning() {
  shutdown.signal.throwIfAborted();
  host?.assertQuiet();
}

async function closeProcesses() {
  const currentWorker = worker;
  const currentGateway = active;
  worker = undefined;
  active = undefined;

  try {
    await currentWorker?.close();
  } finally {
    await currentGateway?.close();
  }
}

function selectedPhases(): DiagnosticsPhase[] {
  const forensicPhase = process.env["CANOPY_BENCH_FORENSIC_PHASE"];

  if (process.env["CANOPY_BENCH_FORENSICS_DIR"] && forensicPhase) {
    if (forensicPhase === "steady" || forensicPhase === "slow_reader" || forensicPhase === "governor")
      return [forensicPhase];
    throw new Error("Choose steady, slow_reader or governor for forensic evidence");
  }

  if (process.env["CANOPY_BENCH_RESOURCES"] === "1") return ["idle"];

  if (process.env["CANOPY_BENCH_ALL_PHASES"] === "1")
    return [
      "idle",
      "steady",
      "reconnect",
      "slow_reader",
      "write_failure",
      "pool_contention",
      ...(process.env["CANOPY_BENCH_STAGE"] === "2" ? ["governor" as const] : []),
    ];

  if (process.env["CANOPY_BENCH_CONTENTION"] === "1") return ["write_failure", "pool_contention"];

  if (process.env["CANOPY_BENCH_CHURN"] === "1") return ["churn"];

  if (process.env["CANOPY_BENCH_EXTRA_PHASES"] === "1") return ["reconnect", "slow_reader"];

  return ["idle", "steady"];
}

async function command(args: string[], env = process.env) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();

  if (await child.exited) throw new Error("Benchmark subprocess failed");

  return output;
}

async function pgCounters() {
  const cpu = await command(["docker", "exec", name, "cat", "/sys/fs/cgroup/cpu.stat"]);
  const io = await command(["docker", "exec", name, "cat", "/sys/fs/cgroup/io.stat"]);

  return {
    cpuMicros: Number(cpu.match(/^usage_usec (\d+)/m)?.[1] ?? 0),
    writeBytes: [...io.matchAll(/wbytes=(\d+)/g)].reduce((total, value) => total + Number(value[1]), 0),
    writeDevices: Object.fromEntries(
      io
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.split(" ")[0]!, Number(line.match(/\bwbytes=(\d+)/)?.[1] ?? 0)]),
    ),
  };
}

async function checkpoint(database: string) {
  if (process.env["CANOPY_BENCH_CHECKPOINT"] !== "1") return;
  await command(["docker", "exec", name, "psql", "-U", "postgres", "-d", database, "-Atqc", "CHECKPOINT"]);
}

async function measuredGateway(env: Record<string, string | undefined>, series: number, on: boolean) {
  const before = await pgCounters();
  const started = performance.now();
  const gateway = await diagnosticsProcess(env);
  const startupMs = performance.now() - started;
  const after = await pgCounters();
  console.info(
    JSON.stringify({
      phase: "startup",
      series,
      attempt,
      on,
      startupMs,
      pgCpuMicros: after.cpuMicros - before.cpuMicros,
      ioBytes: after.writeBytes - before.writeBytes,
      ioDeviceBytes: Object.fromEntries(
        Object.entries(after.writeDevices).map(([device, bytes]) => [
          device,
          bytes - (before.writeDevices[device] ?? 0),
        ]),
      ),
      ...(await gateway.run("sample")),
    }),
  );

  return gateway;
}

function benchmarkApi() {
  return createClient(
    ui.GatewayService,
    createGrpcTransport({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      interceptors: [
        (next) => (request) => {
          request.header.set("authorization", `Bearer ${token}`);

          return next(request);
        },
      ],
    }),
  );
}

async function waitForRestore(api: ReturnType<typeof benchmarkApi>) {
  const deadline = Date.now() + 30_000;

  while ((await api.getComputerDiagnostics({ limit: 1 })).restoring) {
    assertRunning();

    if (Date.now() > deadline) throw new Error("Background restore did not complete");
    await Bun.sleep(10);
  }
}

async function recordAffinity(gateway: number, worker: number, pair: number, on: boolean) {
  console.info(
    JSON.stringify({
      phase: "affinity",
      series: pair,
      attempt,
      on,
      gateway: (await command(["taskset", "-pc", String(gateway)])).trim(),
      worker: (await command(["taskset", "-pc", String(worker)])).trim(),
      postgres: (await command(["docker", "inspect", "--format", "{{.HostConfig.CpusetCpus}}", name])).trim(),
    }),
  );
}

async function resourceHeap(phase: string, on: boolean, series: number) {
  if (process.env["CANOPY_BENCH_RESOURCES"] !== "1" || !active) return;
  console.info(JSON.stringify({ phase, series, attempt, on, ...(await active.run("gc")) }));
}

async function run(on: boolean, index: number) {
  assertRunning();
  const database = `diagnostics_${index}_${Number(on)}_${attempt}`;
  await command(["docker", "exec", name, "createdb", "-U", "postgres", database]);

  const env = {
    ...process.env,
    CANOPY_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/${database}`,
    CANOPY_SECRETS_KEY: key,
    CANOPY_UI_SERVICE_TOKEN: token,
    CANOPY_PORT: String(gatewayPort),
    CANOPY_BENCH_DIAGNOSTICS: String(Number(on)),
  };

  const seed = await seedClient(env);

  if (process.env["CANOPY_BENCH_HISTORY"] === "1")
    console.info(JSON.stringify({ history: await seedDiagnosticsHistory(env) }));
  await checkpoint(database);
  active = await measuredGateway(env, index + 1, on);
  worker = await diagnosticsWorker({
    ...env,
    CANOPY_BENCH_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    CANOPY_BENCH_WORKER_ID: seed.worker.workerId,
    CANOPY_BENCH_WORKER_CREDENTIAL: seed.worker.credential,
  });

  await recordAffinity(active.pid, worker.pid, index + 1, on);

  const api = benchmarkApi();

  await waitForRestore(api);

  console.info(
    JSON.stringify({ phase: "background_restore", series: index + 1, attempt, on, ...(await active.run("sample")) }),
  );

  await resourceHeap("restored_heap_gc", on, index + 1);

  // Warm runtime, database buffers, histograms and the selected application read before every series.
  for (let count = 0; count < 300; count++) await api.getThread({ threadId: seed.thread });
  await Bun.sleep(5000);

  for (const phase of selectedPhases()) {
    assertRunning();

    const {
      latencies,
      measurement: { beforePg, before, finishContention },
      ...workload
    } = await diagnosticsLoad(
      api,
      seed.thread,
      phase,
      phase === "idle" ? idleMs : loadMs,
      () => worker!.run("reconnect"),
      () => active!.run("sample"),
      () => beginPhase(database, phase, api, seed.thread),
      host ? AbortSignal.any([host.signal, shutdown.signal]) : shutdown.signal,
    );

    const contention = await finishContention?.();
    await checkpoint(database);

    const after = await active.run("end");
    const workerStats = await worker.run("end");
    const afterPg = await pgCounters();
    latencies.sort((a, b) => a - b);
    const hours = after.elapsedMs / 3_600_000;
    console.info(
      JSON.stringify({
        series: index + 1,
        attempt,
        on,
        phase,
        contention,
        ...after,
        worker: { ...workerStats, cpuPercent: workerStats.cpuMicros / workerStats.elapsedMs / 10 },
        cpuPercent: after.cpuMicros / after.elapsedMs / 10,
        pgCpuPercent: (afterPg.cpuMicros - beforePg.cpuMicros) / after.elapsedMs / 10,
        ioBytesPerHour: (afterPg.writeBytes - beforePg.writeBytes) / hours,
        ioDeviceBytesPerHour: Object.fromEntries(
          Object.entries(afterPg.writeDevices).map(([device, bytes]) => [
            device,
            (bytes - (beforePg.writeDevices[device] ?? 0)) / hours,
          ]),
        ),
        walBytesPerHour: (after.walBytes - before.walBytes) / hours,
        persistedBytesPerHour: (after.rollupBytes - before.rollupBytes) / hours,
        writesPerHour: (after.writes - before.writes) / hours,
        rpcP95Ms: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null,
        calls: latencies.length,
        ...workload,
      }),
    );
    assertRunning();

    await forensicHeap(phase);
  }

  await resourceHeap("idle_heap_gc", on, index + 1);

  await worker.close();
  worker = undefined;
  await active.close();
  active = undefined;

  if (process.env["CANOPY_BENCH_RESOURCES"] === "1")
    console.info(JSON.stringify({ phase: "storage", on, resolutions: await diagnosticsStorage(env) }));

  if (on && process.env["CANOPY_BENCH_HISTORY"] === "1") {
    for (let restart = 0; restart < 3; restart++) {
      active = await diagnosticsProcess(env);
      await waitForRestore(benchmarkApi());
      console.info(
        JSON.stringify({
          phase: "restart",
          series: index + 1,
          attempt,
          on,
          restart,
          ...(await active.run(process.env["CANOPY_BENCH_RESOURCES"] === "1" ? "gc" : "sample")),
        }),
      );
      await active.close();
      active = undefined;
    }
  }

  if (on && process.env["CANOPY_BENCH_RESOURCES"] === "1")
    console.info(JSON.stringify({ phase: "write_accounting", ...(await diagnosticsWrites(env)) }));
}

async function beginPhase(
  database: string,
  phase: DiagnosticsPhase,
  api: ReturnType<typeof benchmarkApi>,
  thread: string,
) {
  await checkpoint(database);
  const beforePg = await pgCounters();
  const before = await active!.run("begin", phase);

  if (phase === "governor") await active!.run("governor");
  await worker!.run("begin");
  const finishContention = await diagnosticsContention(name, database, phase, api, thread, forensicCheckpoint());

  return { beforePg, before, finishContention };
}

function forensicCheckpoint() {
  return process.env["CANOPY_BENCH_FORENSICS_DIR"] && process.env["CANOPY_BENCH_FORENSIC_CHECKPOINTS"] === "1"
    ? (point: string) => active!.run("heap", point)
    : undefined;
}

async function forensicHeap(phase: string) {
  if (!process.env["CANOPY_BENCH_FORENSICS_DIR"]) return;

  if (process.env["CANOPY_BENCH_FORENSIC_CHECKPOINTS"] === "1" && phase !== "slow_reader" && phase !== "governor")
    return;
  await active?.run("heap");
}

try {
  await command(
    [
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      ...(process.env["CANOPY_BENCH_PG_CPU"] ? ["--cpuset-cpus", process.env["CANOPY_BENCH_PG_CPU"]!] : []),
      "-e",
      "POSTGRES_PASSWORD",
      "-p",
      `127.0.0.1:${pgPort}:5432`,
      "postgres:17",
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  const deadline = Date.now() + 45_000;

  while (true) {
    const ready = Bun.spawn(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    if ((await ready.exited) === 0) break;

    if (Date.now() > deadline) throw new Error("Private PostgreSQL did not become ready");
    await Bun.sleep(100);
  }

  console.info(
    JSON.stringify({ revision: (await command(["git", "rev-parse", "HEAD"])).trim(), idleMs, loadMs, series }),
  );

  if (process.env["CANOPY_BENCH_SMOKE"] === "1" || process.env["CANOPY_BENCH_RESOURCES"] === "1") {
    console.info(
      JSON.stringify({
        phase: process.env["CANOPY_BENCH_RESOURCES"] === "1" ? "resources_only" : "smoke_only",
        acceptance: false,
      }),
    );
    attempt = 1;
    await run(false, 0);
    await run(true, 0);
  } else
    for (let index = 0; index < series; index++) {
      let accepted = false;

      for (attempt = 1; attempt <= 3; attempt++) {
        host = await monitorHost(index + 1, attempt);
        let completed = false;

        try {
          await Bun.sleep(30_000);
          assertRunning();

          for (const on of process.env["CANOPY_BENCH_CHURN"] === "1"
            ? [true]
            : index % 2
              ? [true, false]
              : [false, true])
            await run(on, index);
          completed = true;
        } catch (error) {
          if (!host.signal.aborted) throw error;
          console.info(JSON.stringify({ phase: "discarded", pair: index + 1, attempt, reason: "host noise" }));
        } finally {
          try {
            await closeProcesses();
          } finally {
            accepted = await host.stop(completed);
            host = undefined;
          }
        }

        if (accepted) break;
      }

      if (!accepted) throw new Error("Three host-noise rejections: a quiet measurement window is unavailable");
    }
} finally {
  try {
    await closeProcesses();
  } finally {
    await command(["docker", "rm", "-f", "-v", name]);
  }
}
