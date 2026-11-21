import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PgClient, PgPool } from "@effect/sql-pg";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { SQL } from "bun";
import { migrate } from "./migrations/index.ts";
import { POSTGRES_MAX_MESSAGE_BYTES } from "./limits.ts";

export const testDatabase = (port: number, database: string) =>
  PgClient.layer({
    host: "127.0.0.1",
    port,
    database,
    username: "postgres",
    password: Redacted.make("test"),
    maxMessageSize: POSTGRES_MAX_MESSAGE_BYTES,
  });

export const testDatabasePool = (port: number, database: string) =>
  Layer.effect(
    PgPool.PgPool,
    PgPool.make({
      host: "127.0.0.1",
      port,
      database,
      username: "postgres",
      password: Redacted.make("test"),
      maxMessageSize: POSTGRES_MAX_MESSAGE_BYTES,
    }),
  );

export const testAdmin = (port: number) =>
  new SQL({ hostname: "127.0.0.1", port, database: "postgres", username: "postgres", password: "test", max: 1 });

/** Owned by check:tmp, shared by its test process. Each fixture still gets a separate database. */
export async function startTestPostgresServer(major: 17 | 18 = 17) {
  const owner = fork(fileURLToPath(new URL("./testing-container.ts", import.meta.url)), [String(major)], {
    execArgv: [],
    detached: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    owner.once("exit", resolve);
    owner.once("error", reject);
  });

  const stop = async () => {
    owner.ref();

    if (owner.connected) owner.disconnect();

    if ((await exited) !== 0) throw new Error("Test PostgreSQL container cleanup failed");
  };

  try {
    const port = await Promise.race([
      new Promise<number>((resolve) => owner.once("message", resolve)),
      exited.then(() => {
        throw new Error("Test PostgreSQL container failed to start");
      }),
    ]);

    owner.unref();
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
