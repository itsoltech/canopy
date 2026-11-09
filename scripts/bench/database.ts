import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

/** Always owns a new server and database. Never accepts a URL to an existing database. */
export async function database() {
  const directory = await mkdtemp(join("/var/tmp", "canopy-db-bench-"));
  const name = `canopy-db-bench-${Bun.randomUUIDv7()}`;

  const command = [
    "docker",
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "--user",
    `${process.getuid?.()}:${process.getgid?.()}`,
    "--memory",
    "1536m",
    "--cpus",
    "2",
    "--mount",
    `type=bind,source=${directory},target=/var/lib/postgresql`,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "postgres:18",
    "-c",
    "max_connections=40",
    "-c",
    "shared_buffers=128MB",
    "-c",
    "shared_preload_libraries=pg_stat_statements",
  ];

  const started = Bun.spawnSync(command);

  if (started.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Benchmark PostgreSQL could not start: ${started.stderr.toString()}`);
  }

  const stop = async () => {
    const child = Bun.spawn(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "inherit" });

    if ((await child.exited) !== 0) throw new Error(`Could not remove owned benchmark container ${name}`);
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const mapping = Bun.spawnSync(["docker", "port", name, "5432/tcp"]);
    const port = Number(mapping.stdout.toString().trim().split(":").at(-1));
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const admin = new SQL({ url, max: 1 });

    try {
      const deadline = Date.now() + 60_000;

      for (;;) {
        try {
          await admin`SELECT 1`;
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await Bun.sleep(100);
        }
      }

      await admin`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
    } finally {
      await admin.close();
    }

    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
