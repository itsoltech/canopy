import { PgClient } from "@effect/sql-pg";
import { Redacted, type Layer } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

export const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

export interface TestPostgres {
  readonly layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, SqlError.SqlError>;
  readonly stop: () => void;
}

const CREATED_LABEL = "open-agents-test.created";
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Containers of test runs that were killed before `stop` (an interrupted run never reaches afterAll). */
function removeStaleContainers() {
  const list = Bun.spawnSync(["docker", "ps", "-a", "--filter", `label=${CREATED_LABEL}`, "--format", `{{.Names}} {{.Label "${CREATED_LABEL}"}}`]);
  const stale = list.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(([name, created]) => name && Date.now() - Number(created) > STALE_AFTER_MS)
    .map(([name]) => name as string);
  if (stale.length > 0) Bun.spawnSync(["docker", "rm", "-f", "-v", ...stale], { stdout: "ignore", stderr: "ignore" });
}

/** Throwaway PostgreSQL 17 in Docker on a random local port (tests only). */
export async function startPostgres(): Promise<TestPostgres> {
  removeStaleContainers();
  const name = `open-agents-test-${Bun.randomUUIDv7().slice(-12)}`;
  const run = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", name, "--label", `${CREATED_LABEL}=${Date.now()}`,
    "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:17",
  ]);
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);
  // A throwaway container: killed and removed without waiting. A graceful `docker stop` (checkpoint, then exit)
  // took 3-4 s under load, past the 5 s afterAll limit of every suite that stops it.
  const stop = () => Bun.spawn(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "ignore" }).unref();

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
