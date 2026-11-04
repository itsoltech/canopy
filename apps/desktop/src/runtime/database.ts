import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { spawn, spawnSync } from "node:child_process";
import { freePort } from "./config.ts";
import { Supervisor, until } from "./process.ts";

/** Foreground postgres: the supervisor owns its PID, never a daemon launched by pg_ctl. */
export async function startDatabase(options: {
  directory: string;
  binaries: string;
  password: string;
  supervisor: Supervisor;
  env: NodeJS.ProcessEnv;
}) {
  const { directory, binaries, password, supervisor, env } = options;
  const binary = (name: string) => join(binaries, "bin", name + (process.platform === "win32" ? ".exe" : ""));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data = join(directory, "data");

  if (!existsSync(join(data, "PG_VERSION"))) {
    const pwfile = join(directory, "init-password");
    writeFileSync(pwfile, `${password}\n`, { mode: 0o600 });

    try {
      await supervisor.run({
        name: "initdb",
        command: binary("initdb"),
        args: [
          "-D",
          data,
          "-U",
          "canopy",
          "--encoding=UTF8",
          "--locale=C",
          "--auth-host=scram-sha-256",
          "--auth-local=reject",
          `--pwfile=${pwfile}`,
        ],
        cwd: directory,
        env,
      });
    } finally {
      unlinkSync(pwfile);
    }
  }

  await stopOrphan(data, binary("pg_ctl"), env);
  const port = await freePort();
  const base = `postgres://canopy:${encodeURIComponent(password)}@127.0.0.1:${port}`;
  // PostgreSQL checks stale postmaster.pid and replays WAL itself. Never delete a live lock.
  supervisor.start({
    name: "postgres",
    command: binary("postgres"),
    args: [
      "-D",
      data,
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      ...(process.platform === "win32" ? [] : ["-k", ""]),
      "-c",
      "max_connections=40",
    ],
    cwd: directory,
    env,
    restart: true,
    stopSignal: "SIGINT",
    ...(process.platform === "win32" && {
      stop: () =>
        new Promise<void>((resolve, reject) => {
          const control = spawn(binary("pg_ctl"), ["stop", "-D", data, "-m", "fast", "-w", "-t", "8"], {
            env,
            stdio: "ignore",
            windowsHide: true,
          });

          control.once("error", reject);
          control.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Postgres shutdown failed"))));
        }),
    }),
  });
  await until(async () => {
    const sql = new SQL(`${base}/postgres`, { max: 1, connectionTimeout: 1 });

    try {
      await sql`SELECT 1`;

      return true;
    } finally {
      await sql.close();
    }
  });
  const sql = new SQL(`${base}/postgres`, { max: 1 });

  try {
    if ((await sql`SELECT 1 FROM pg_database WHERE datname = 'canopy'`).length === 0)
      await sql.unsafe("CREATE DATABASE canopy");
  } finally {
    await sql.close();
  }

  return `${base}/canopy`;
}

/**
 * A postmaster left running by a previous run whose guardian was killed outright (kill -9, OOM): it still holds the
 * data directory, so a new one could never start. Stop it before starting ours — only if the PID in postmaster.pid
 * is a postgres serving exactly this data directory (never another process that reused the PID).
 */
async function stopOrphan(data: string, pgCtl: string, env: NodeJS.ProcessEnv) {
  const lock = join(data, "postmaster.pid");

  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, "utf8").split("\n")[0]);

  if (!Number.isInteger(pid) || pid <= 0 || !ownsDataDir(pid, data, pgCtl, env)) return;

  for (const mode of ["fast", "immediate"]) {
    const stop = spawnSync(pgCtl, ["stop", "-D", data, "-m", mode, "-w", "-t", "15"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    if (stop.status === 0) return;
  }

  throw new Error("A previous Canopy database is still running and could not be stopped");
}

function ownsDataDir(pid: number, data: string, pgCtl: string, env: NodeJS.ProcessEnv): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(data);
    } catch {
      return false;
    }
  }

  if (process.platform === "darwin") {
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });

    return ps.status === 0 && ps.stdout.includes("postgres") && ps.stdout.includes(data);
  }

  // Windows: pg_ctl checks the PID file against a running postmaster itself.
  return spawnSync(pgCtl, ["status", "-D", data], { env, stdio: "ignore", windowsHide: true }).status === 0;
}
