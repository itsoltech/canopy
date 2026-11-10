import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { seedClient } from "./seed-client.ts";
import { clientWorker } from "./client-worker.ts";
import { seedDiagnostics } from "./seed-diagnostics.ts";

/** Private disposable gateway/BFF for renderer profiling; never reads a developer's stack config. */
const root = resolve(import.meta.dir, "../..");
const temp = process.env["TMPDIR"];

if (!temp || temp === "/tmp" || !temp.startsWith("/"))
  throw new Error("Set TMPDIR to a private, disk-backed absolute directory before starting the benchmark");

await mkdir(temp, { recursive: true });

const forbidden = new Set([17443, 5180, 8444, 17444, 17445, 3000, 7443, 7432, 4443, 7444, 5291, 8081]);

const port = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < 1024 || value > 65535 || forbidden.has(value))
    throw new Error(`Choose an unused non-reserved port for ${name}`);

  return value;
};

const webPort = port("CANOPY_BENCH_WEB_PORT", 15437);
const gatewayPort = port("CANOPY_BENCH_GATEWAY_PORT", 15438);
const pgPort = port("CANOPY_BENCH_PG_PORT", 15439);
const production = process.env["CANOPY_BENCH_PRODUCTION"] === "1";
const diagnostics = process.env["CANOPY_BENCH_DIAGNOSTICS_PREVIEW"] === "1";
const emptyDiagnostics = process.env["CANOPY_BENCH_DIAGNOSTICS_EMPTY"] === "1";

if (new Set([webPort, gatewayPort, pgPort]).size !== 3) throw new Error("Benchmark ports must differ");

const name = `canopy-client-bench-${process.pid}`;
const password = randomBytes(24).toString("hex");
const token = randomBytes(32).toString("hex");
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
let stopWorker: (() => Promise<void>) | undefined;

async function stop() {
  if (stopping) return;
  stopping = true;
  await stopWorker?.();

  for (const child of children.toReversed()) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.exited));
  await Bun.spawn(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "ignore" }).exited;
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void stop().then(() => process.exit(0)));

try {
  const docker = Bun.spawn(
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
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdout: "ignore", stderr: "inherit" },
  );

  if ((await docker.exited) !== 0) throw new Error("Could not start private PostgreSQL");

  const deadline = Date.now() + 45_000;

  while (
    (await Bun.spawn(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited) !== 0
  ) {
    if (Date.now() > deadline) throw new Error("Private PostgreSQL did not become ready");
    await Bun.sleep(100);
  }

  const gatewayEnv = {
    ...process.env,
    CANOPY_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/postgres`,
    CANOPY_SECRETS_KEY: randomBytes(32).toString("base64"),
    CANOPY_UI_SERVICE_TOKEN: token,
    CANOPY_HOST: "127.0.0.1",
    CANOPY_GATEWAY_ROLE: diagnostics ? "desktop" : "server",
    CANOPY_PORT: String(gatewayPort),
    CANOPY_NETWORK_PORT: undefined,
    CANOPY_DEV_USER_EMAIL: "dev@localhost",
  };

  const seeded = process.env["CANOPY_BENCH_SEED"] === "0" ? undefined : await seedClient(gatewayEnv);

  if (diagnostics && !emptyDiagnostics) await seedDiagnostics(gatewayEnv);

  children.push(
    Bun.spawn(["bun", emptyDiagnostics ? "scripts/bench/diagnostics-entry.ts" : "apps/gateway/src/main.ts"], {
      cwd: root,
      env: gatewayEnv,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );

  if (seeded) stopWorker = await clientWorker(`http://127.0.0.1:${gatewayPort}`, seeded.worker);
  children.push(
    Bun.spawn(
      production ? ["bun", "run", "start"] : ["bun", "run", "dev", "--host", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: resolve(root, "apps/web"),
        env: {
          ...process.env,
          GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
          GATEWAY_SERVICE_TOKEN: token,
          HOST: "127.0.0.1",
          PORT: String(webPort),
          ORIGIN: `http://127.0.0.1:${webPort}`,
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  );

  if (!production) console.info(`Renderer fixture: http://127.0.0.1:${webPort}/dev/long-thread?turns=1000`);

  if (seeded) console.info(`Seeded thread: http://127.0.0.1:${webPort}/threads/${seeded.thread}`);
  console.info(`Stop this process (${process.pid}) to remove its servers and database.`);
  await Promise.race(children.map((child) => child.exited));
} finally {
  await stop();
}
