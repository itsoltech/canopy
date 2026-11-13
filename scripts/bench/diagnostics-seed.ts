import { join } from "node:path";
import { Schema } from "effect";
import { seedClient } from "./seed-client.ts";

const Seed = Schema.Struct({
  thread: Schema.String,
  turn: Schema.String,
  worker: Schema.Struct({ workerId: Schema.String, credential: Schema.String }),
});

/** Baseline product modules and migrator are loaded by the baseline's own seed process. */
export async function seedBenchmark(env: Record<string, string | undefined>) {
  const root = env["CANOPY_BENCH_SOURCE_ROOT"];

  if (!root) return seedClient(env);
  let seed: typeof Seed.Type | undefined;

  const child = Bun.spawn([process.execPath, join(root, "scripts/bench/diagnostics-dev-seed.ts")], {
    env,
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      seed = Schema.decodeUnknownSync(Seed)(message);
    },
  });

  if ((await child.exited) || !seed) throw new Error("Baseline fixture could not be seeded");

  return seed;
}
