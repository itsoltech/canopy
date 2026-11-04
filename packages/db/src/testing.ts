import { PgClient } from "@effect/sql-pg";
import { Redacted, type Layer } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

export const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

export interface TestPostgres {
  readonly layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, SqlError.SqlError>;
  readonly stop: () => void;
}

const CREATED_LABEL = "canopy-test.created";

/** Throwaway PostgreSQL 17 in Docker on a random local port (tests only). */
export async function startPostgres(): Promise<TestPostgres> {
  // Other runs may still own old containers. Only stop the container created below.
  const name = `canopy-test-${Bun.randomUUIDv7().slice(-12)}`;

  const run = Bun.spawnSync([
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    `${CREATED_LABEL}=${Date.now()}`,
    "-e",
    "POSTGRES_PASSWORD=test",
    // Throwaway data: no fsync at init or at run time. Under load the synced initdb alone took tens of seconds.
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
  // A throwaway container: killed and removed without waiting. A graceful `docker stop` (checkpoint, then exit)
  // took 3-4 s under load, past the 5 s afterAll limit of every suite that stops it.
  const stop = () => Bun.spawn(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "ignore" }).unref();

  try {
    const port = Number(Bun.spawnSync(["docker", "port", name, "5432/tcp"]).stdout.toString().trim().split(":").at(-1));

    // pg_isready inside the container flips before the final restart of the entrypoint; wait for a real query.
    // Asynchronously: a blocking probe stalls everything else in the test process (other gateways' links too).
    // Before the 60 s beforeAll limit of the suites, so the failure names its cause.
    const deadline = Date.now() + 45_000;

    for (;;) {
      const probe = Bun.spawn(["docker", "exec", name, "psql", "-U", "postgres", "-h", "127.0.0.1", "-c", "select 1"], {
        stdout: "ignore",
        stderr: "pipe",
      });

      const [code, error] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);

      if (code === 0) break;

      if (Date.now() > deadline) throw new Error(`postgres did not become ready: ${error.trim()}`);
      await Bun.sleep(250);
    }

    const layer = PgClient.layer({
      host: "127.0.0.1",
      port,
      database: "postgres",
      username: "postgres",
      password: Redacted.make("test"),
    });

    return { layer, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
