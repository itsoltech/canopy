import { randomBytes } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { diagnosticsProcess } from "./diagnostics-process.ts";
import { seedClient } from "./seed-client.ts";

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
const name = `canopy-diagnostics-bench-${process.pid}`;
const password = randomBytes(24).toString("hex");
const token = randomBytes(32).toString("hex");
const key = randomBytes(32).toString("base64");
let active: Awaited<ReturnType<typeof diagnosticsProcess>> | undefined;
let worker: ReturnType<typeof Bun.spawn> | undefined;

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
  };
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
  active = await diagnosticsProcess(env);
  worker = Bun.spawn([process.execPath, `${import.meta.dir}/diagnostics-worker.ts`], {
    env: {
      ...env,
      CANOPY_BENCH_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      CANOPY_BENCH_WORKER_ID: seed.worker.workerId,
      CANOPY_BENCH_WORKER_CREDENTIAL: seed.worker.credential,
    },
    stdout: "ignore",
    stderr: "inherit",
    ipc() {},
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

  for (const phase of ["idle", "steady"] as const) {
    const beforePg = await pgCounters();
    const before = await active.run("begin");
    const latencies: number[] = [];
    const until = performance.now() + (phase === "idle" ? idleMs : loadMs);

    if (phase === "idle") {
      while (performance.now() < until) await Bun.sleep(Math.min(1000, until - performance.now()));
    } else {
      // Fixed offered load: 20 real application reads/s, four independent client lanes.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (performance.now() < until) {
            const start = performance.now();
            await api.getThread({ threadId: seed.thread });
            latencies.push(performance.now() - start);
            await Bun.sleep(Math.max(0, 200 - (performance.now() - start)));
          }
        }),
      );
    }

    const after = await active.run("end");
    const afterPg = await pgCounters();
    latencies.sort((a, b) => a - b);
    const hours = after.elapsedMs / 3_600_000;
    console.info(
      JSON.stringify({
        series: index + 1,
        on,
        phase,
        ...after,
        cpuPercent: after.cpuMicros / after.elapsedMs / 10,
        pgCpuPercent: (afterPg.cpuMicros - beforePg.cpuMicros) / after.elapsedMs / 10,
        ioBytesPerHour: (afterPg.writeBytes - beforePg.writeBytes) / hours,
        walBytesPerHour: (after.walBytes - before.walBytes) / hours,
        persistedBytesPerHour: (after.rollupBytes - before.rollupBytes) / hours,
        writesPerHour: (after.writes - before.writes) / hours,
        rpcP95Ms: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null,
        calls: latencies.length,
      }),
    );
  }

  worker.send({ stop: true });
  await worker.exited;
  worker = undefined;
  await active.close();
  active = undefined;
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
    for (const on of index % 2 ? [true, false] : [false, true]) await run(on, index);
  }
} finally {
  if (worker) {
    worker.kill("SIGTERM");
    await worker.exited;
  }

  try {
    await active?.close();
  } finally {
    await command(["docker", "rm", "-f", "-v", name]);
  }
}
