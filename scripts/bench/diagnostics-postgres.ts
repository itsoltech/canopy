import { SQL } from "bun";
import { mkdtemp, chmod, cp, readdir, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { scopeSample, userScope, swapDisabledStage } from "./diagnostics-scope.ts";

async function command(args: string[], env = process.env) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();

  if (await child.exited) throw new Error("Benchmark PostgreSQL command failed");

  return output;
}

/** npm archives can omit SONAME aliases; repair only our disposable runtime copy. */
async function prepareRuntime(source: string, directory: string) {
  const runtime = join(directory, "runtime");
  await cp(source, runtime, { recursive: true });
  const library = join(runtime, "lib");
  const entries = await readdir(library);

  for (const entry of entries) {
    const alias = entry.match(/^(.+\.so\.\d+)\.\d+$/)?.[1];

    if (alias && !entries.includes(alias)) await symlink(entry, join(library, alias));
  }

  return join(runtime, "bin");
}

async function initialize(binaries: string, data: string, pwfile: string, password: string) {
  await Bun.write(pwfile, `${password}\n`, { mode: 0o600 });

  try {
    await command([
      join(binaries, "initdb"),
      "-D",
      data,
      "-U",
      "postgres",
      "--encoding=UTF8",
      "--locale=C",
      "--auth-host=scram-sha-256",
      "--auth-local=reject",
      `--pwfile=${pwfile}`,
    ]);
  } finally {
    await rm(pwfile, { force: true });
  }
}

function launch(binaries: string, data: string, port: number, unit: string, parentUnit: string) {
  return Bun.spawn(
    [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      `--unit=${unit}`,
      "-p",
      "MemorySwapMax=0",
      "-p",
      "KillSignal=SIGINT",
      "-p",
      "TimeoutStopSec=10s",
      "-p",
      `BindsTo=${parentUnit}`,
      "-p",
      `After=${parentUnit}`,
      "--",
      ...(process.env["CANOPY_BENCH_PG_CPU"] ? ["taskset", "-c", process.env["CANOPY_BENCH_PG_CPU"]!] : []),
      join(binaries, "postgres"),
      "-D",
      data,
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-k",
      "",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
}

/** Native foreground PostgreSQL inherits a user scope; Docker's daemon cannot do that. */
async function nativePostgres(port: number, password: string) {
  const parentScope = await userScope();

  if ((await scopeSample(parentScope)).swapCurrent !== 0) throw new Error("Benchmark scope contains swapped pages");
  const source = realpathSync(require.resolve(`@embedded-postgres/${process.platform}-${process.arch}`));
  const distribution = resolve(dirname(source), "../native");
  const directory = await mkdtemp(join(tmpdir(), "canopy-diagnostics-pg-"));
  await chmod(directory, 0o700);
  const data = join(directory, "data");
  const pwfile = join(directory, "password");
  const unit = `canopy-diagnostics-pg-${process.pid}-${crypto.randomUUID()}.scope`;
  let child: ReturnType<typeof launch> | undefined;

  const query = async (database: string, text: string) => {
    const sql = new SQL(`postgres://postgres:${password}@127.0.0.1:${port}/${database}`, {
      max: 1,
      connectionTimeout: 1,
    });

    try {
      // Only the lock fixture uses multiple statements; its result is deliberately discarded.
      if (text.includes(";")) {
        await sql.unsafe(text).simple();

        return "";
      }

      const rows = await sql.unsafe<(string | number | bigint | null)[][]>(text).values();

      return rows.map((row) => row.join("\t")).join("\n");
    } finally {
      await sql.close();
    }
  };

  const close = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      // Exact UUID scope created here; also catches PostgreSQL children during failed startup.
      await command(["systemctl", "--user", "stop", unit]);
      await child.exited;
    }

    await rm(directory, { recursive: true, force: true });
  };

  try {
    const binaries = await prepareRuntime(distribution, directory);
    await initialize(binaries, data, pwfile, password);
    child = launch(binaries, data, port, unit, basename(parentScope));
    const deadline = Date.now() + 45_000;

    while (true) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Private PostgreSQL did not become ready");

      try {
        await query("postgres", "SELECT 1");
        break;
      } catch {
        await Bun.sleep(100);
      }
    }

    const pid = Number((await Bun.file(join(data, "postmaster.pid")).text()).split("\n")[0]);

    if (!Number.isInteger(pid) || pid <= 0) throw new Error("PostgreSQL PID unavailable");
    const scope = await userScope(pid);

    if (basename(scope) !== unit) throw new Error("PostgreSQL escaped its benchmark scope");
    const sample = await scopeSample(scope);
    const ioAvailable = await Bun.file(`${scope}/io.stat`).exists();

    if (sample.swapCurrent) throw new Error("PostgreSQL scope already contains swapped pages");
    console.info(
      JSON.stringify({
        phase: "postgres_scope",
        pid,
        ...sample,
        version: await query("postgres", "SHOW server_version"),
        binary: join(binaries, "postgres"),
        ioAccounting: ioAvailable ? "cgroup" : "unavailable: io controller not delegated",
      }),
    );

    return {
      query,
      close,
      scope,
      affinity: () => command(["taskset", "-pc", String(pid)]),
      counters: () => cgroupCounters(scope, undefined, ioAvailable),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Keep the original Docker fixture available for historical stage 1 recordings. */
async function dockerPostgres(port: number, password: string) {
  const name = `canopy-diagnostics-bench-${process.pid}`;
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
      `127.0.0.1:${port}:5432`,
      "postgres:17",
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );

  const query = (database: string, text: string) =>
    command(["docker", "exec", name, "psql", "-U", "postgres", "-d", database, "-Atqc", text]);

  const close = () => command(["docker", "rm", "-f", "-v", name]).then(() => {});

  try {
    const deadline = Date.now() + 45_000;

    while (true) {
      try {
        await query("postgres", "SELECT 1");
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Private PostgreSQL did not become ready");
        await Bun.sleep(100);
      }
    }

    return {
      query,
      close,
      scope: undefined,
      affinity: () => command(["docker", "inspect", "--format", "{{.HostConfig.CpusetCpus}}", name]),
      counters: () => cgroupCounters("/sys/fs/cgroup", (file) => command(["docker", "exec", name, "cat", file])),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function cgroupCounters(scope: string, read = (file: string) => Bun.file(file).text(), ioAvailable = true) {
  const cpu = await read(`${scope}/cpu.stat`);
  const io = ioAvailable ? await read(`${scope}/io.stat`) : undefined;
  const usage = cpu.match(/^usage_usec (\d+)/m)?.[1];

  if (!usage) throw new Error("PostgreSQL CPU accounting unavailable");

  return {
    cpuMicros: Number(usage),
    writeBytes:
      io === undefined ? null : [...io.matchAll(/wbytes=(\d+)/g)].reduce((total, value) => total + Number(value[1]), 0),
    writeDevices:
      io === undefined
        ? null
        : Object.fromEntries(
            io
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line): [string, number] => [line.split(" ")[0]!, Number(line.match(/\bwbytes=(\d+)/)?.[1] ?? 0)]),
          ),
  };
}

export const startBenchPostgres = (port: number, password: string) =>
  swapDisabledStage() ? nativePostgres(port, password) : dockerPostgres(port, password);

export type BenchPostgres = Awaited<ReturnType<typeof startBenchPostgres>>;

/** Missing delegated I/O accounting is explicit, never represented as zero physical writes. */
export function postgresIoDelta(
  before: Awaited<ReturnType<BenchPostgres["counters"]>>,
  after: Awaited<ReturnType<BenchPostgres["counters"]>>,
  scale = 1,
) {
  const previous = before.writeDevices;

  return {
    bytes:
      before.writeBytes === null || after.writeBytes === null ? null : (after.writeBytes - before.writeBytes) / scale,
    devices:
      previous === null || after.writeDevices === null
        ? null
        : Object.fromEntries(
            Object.entries(after.writeDevices).map(([device, bytes]): [string, number] => [
              device,
              (bytes - (previous[device] ?? 0)) / scale,
            ]),
          ),
  };
}
