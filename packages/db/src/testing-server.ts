import { PgClient } from "@effect/sql-pg";
import { ManagedRuntime, Redacted } from "effect";
import { SQL } from "bun";
import { migrate } from "./migrations/index.ts";

export const testDatabase = (port: number, database: string) =>
  PgClient.layer({ host: "127.0.0.1", port, database, username: "postgres", password: Redacted.make("test") });

export const testAdmin = (port: number) =>
  new SQL({ hostname: "127.0.0.1", port, database: "postgres", username: "postgres", password: "test", max: 1 });

/** Owned by check:tmp, shared by its test process. Each fixture still gets a separate database. */
export async function startTestPostgresServer() {
  const name = `canopy-test-${Bun.randomUUIDv7().slice(-12)}`;

  const run = Bun.spawnSync([
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    `canopy-test.created=${Date.now()}`,
    "-e",
    "POSTGRES_PASSWORD=test",
    "-e",
    "POSTGRES_INITDB_ARGS=--no-sync",
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
    "-c",
    "full_page_writes=off",
  ]);

  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);

  // Await removal: no detached docker children delay temp-directory cleanup in the test process.
  const stop = async () => {
    const child = Bun.spawn(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "ignore" });

    if ((await child.exited) !== 0) throw new Error(`Could not remove test container ${name}`);
  };

  try {
    const port = Number(Bun.spawnSync(["docker", "port", name, "5432/tcp"]).stdout.toString().trim().split(":").at(-1));
    const admin = testAdmin(port);

    try {
      const deadline = Date.now() + 45_000;

      for (;;) {
        try {
          // The entrypoint's temporary server has no published TCP listener. Wait for the final one.
          await admin`SELECT 1`;
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await Bun.sleep(50);
        }
      }

      await admin.unsafe("CREATE DATABASE canopy_template");
      const runtime = ManagedRuntime.make(testDatabase(port, "canopy_template"));

      try {
        await runtime.runPromise(migrate);
      } finally {
        await runtime.dispose();
      }

      await admin.unsafe("ALTER DATABASE canopy_template WITH IS_TEMPLATE true ALLOW_CONNECTIONS false");
    } finally {
      await admin.close();
    }

    return { port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
