import { PgClient } from "@effect/sql-pg";
import { Redacted, type Layer } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

export const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

export interface TestPostgres {
  readonly layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, SqlError.SqlError>;
  readonly stop: () => void;
}

/** Throwaway PostgreSQL 17 in Docker on a random local port (tests only). */
export async function startPostgres(): Promise<TestPostgres> {
  const name = `open-agents-test-${Bun.randomUUIDv7().slice(-12)}`;
  const run = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:17",
  ]);
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);
  const stop = () => void Bun.spawnSync(["docker", "stop", name], { stdout: "ignore", stderr: "ignore" });

  try {
    const port = Number(Bun.spawnSync(["docker", "port", name, "5432/tcp"]).stdout.toString().trim().split(":").at(-1));
    // pg_isready inside the container flips before the final restart of the entrypoint; wait for a real query.
    for (let attempt = 0; ; attempt++) {
      const ready = Bun.spawnSync(["docker", "exec", name, "psql", "-U", "postgres", "-h", "127.0.0.1", "-c", "select 1"]);
      if (ready.exitCode === 0) break;
      if (attempt > 60) throw new Error("postgres did not become ready");
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
