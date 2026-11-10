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

/** Isolated, durable PostgreSQL. Defaults implement the three alternating ten-minute idle series. */
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
const series = Number(process.env["CANOPY_BENCH_SERIES"] ?? 3);

if (process.env["CANOPY_BENCH_CONTENTION"] === "1" && loadMs < 140_000)
  throw new Error("Contention phases need 70 seconds of locking and at least 70 seconds of recovery");

const name = `canopy-diagnostics-bench-${process.pid}`;
const password = randomBytes(24).toString("hex");
const token = randomBytes(32).toString("hex");
const key = randomBytes(32).toString("base64");
let active: Awaited<ReturnType<typeof diagnosticsProcess>> | undefined;
let worker: Awaited<ReturnType<typeof diagnosticsWorker>> | undefined;

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

async function run(on: boolean, index: number) {
  const database = `diagnostics_${index}_${Number(on)}`;
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

  const api = createClient(
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

  // Warm runtime, database buffers, histograms and the selected application read before every series.
  for (let count = 0; count < 300; count++) await api.getThread({ threadId: seed.thread });
  await Bun.sleep(5000);

  const phases: DiagnosticsPhase[] =
    process.env["CANOPY_BENCH_CONTENTION"] === "1"
      ? ["write_failure", "pool_contention"]
      : process.env["CANOPY_BENCH_CHURN"] === "1"
        ? ["churn"]
        : process.env["CANOPY_BENCH_EXTRA_PHASES"] === "1"
          ? ["reconnect", "slow_reader"]
          : ["idle", "steady"];

  for (const phase of phases) {
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
      async () => {
        await checkpoint(database);
        const beforePg = await pgCounters();
        const before = await active!.run("begin");
        await worker!.run("begin");
        const finishContention = await diagnosticsContention(name, database, phase, api, seed.thread);

        return { beforePg, before, finishContention };
      },
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
  }

  await worker.close();
  worker = undefined;
  await active.close();
  active = undefined;

  if (on && process.env["CANOPY_BENCH_HISTORY"] === "1") {
    for (let restart = 0; restart < 3; restart++) {
      active = await diagnosticsProcess(env);
      console.info(JSON.stringify({ phase: "restart", restart, ...(await active.run("sample")) }));
      await active.close();
      active = undefined;
    }
  }
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

  for (let index = 0; index < series; index++) {
    for (const on of process.env["CANOPY_BENCH_CHURN"] === "1" ? [true] : index % 2 ? [true, false] : [false, true])
      await run(on, index);
  }
} finally {
  if (worker) {
    await worker.close();
  }

  try {
    await active?.close();
  } finally {
    await command(["docker", "rm", "-f", "-v", name]);
  }
}
