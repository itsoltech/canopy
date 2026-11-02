import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { spawn } from "node:child_process";
import { freePort } from "./config.ts";
import { Supervisor, until } from "./process.ts";

/** Foreground postgres: the supervisor owns its PID, never a daemon launched by pg_ctl. */
export async function startDatabase(options: { directory: string; binaries: string; password: string; supervisor: Supervisor; env: NodeJS.ProcessEnv }) {
  const { directory, binaries, password, supervisor, env } = options;
  const binary = (name: string) => join(binaries, "bin", name + (process.platform === "win32" ? ".exe" : ""));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data = join(directory, "data");
  if (!existsSync(join(data, "PG_VERSION"))) {
    const pwfile = join(directory, "init-password");
    writeFileSync(pwfile, `${password}\n`, { mode: 0o600 });
    try {
      await supervisor.run({ name: "initdb", command: binary("initdb"), args: ["-D", data, "-U", "canopy", "--encoding=UTF8", "--locale=C", "--auth-host=scram-sha-256", "--auth-local=reject", `--pwfile=${pwfile}`], cwd: directory, env });
    } finally { unlinkSync(pwfile); }
  }
  const port = await freePort();
  const base = `postgres://canopy:${encodeURIComponent(password)}@127.0.0.1:${port}`;
  // PostgreSQL checks stale postmaster.pid and replays WAL itself. Never delete a live lock.
  supervisor.start({ name: "postgres", command: binary("postgres"), args: ["-D", data, "-h", "127.0.0.1", "-p", String(port), ...(process.platform === "win32" ? [] : ["-k", ""]), "-c", "max_connections=40"], cwd: directory, env, restart: true, stopSignal: "SIGINT",
    ...(process.platform === "win32" && { stop: () => new Promise<void>((resolve, reject) => {
      const control = spawn(binary("pg_ctl"), ["stop", "-D", data, "-m", "fast", "-w", "-t", "8"], { env, stdio: "ignore", windowsHide: true });
      control.once("error", reject); control.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Postgres shutdown failed")));
    }) }),
  });
  await until(async () => {
    const sql = new SQL(`${base}/postgres`, { max: 1, connectionTimeout: 1 });
    try { await sql`SELECT 1`; return true; } finally { await sql.close(); }
  });
  const sql = new SQL(`${base}/postgres`, { max: 1 });
  try {
    if ((await sql`SELECT 1 FROM pg_database WHERE datname = 'canopy'`).length === 0) await sql.unsafe('CREATE DATABASE canopy');
  } finally { await sql.close(); }
  return `${base}/canopy`;
}
