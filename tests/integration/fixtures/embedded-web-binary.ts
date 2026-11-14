/** Standalone gateway fixture with an embedded web: the real supervisor, update runtime, web process and runner. */
import { appendFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import type { JsonObject } from "@canopy/domain";
import { onSupervisorHandover, superviseBinary, UPDATE_RESTART_EXIT_CODE } from "@canopy/updater";
import { GatewayUpdates } from "../../../apps/gateway/src/updates/runtime.ts";
import { EmbeddedWebProcess } from "../../../apps/gateway/src/web/process.ts";
import { serveEmbeddedWeb } from "../../../apps/gateway/src/web/serve.ts";

const directory = process.env["CANOPY_TEST_DIRECTORY"]!;
const binaryPath = join(directory, "installed");

function event(type: string, details: JsonObject = {}) {
  appendFileSync(
    join(directory, "events.jsonl"),
    JSON.stringify({ type, version: CANOPY_VERSION, pid: process.pid, ...details }) + "\n",
  );
}

if (Bun.argv[2] === "web") {
  event("web");
  const code = await serveEmbeddedWeb();

  if (code !== undefined) process.exit(code);
} else if (!process.env["CANOPY_SUPERVISED"]) {
  event("supervisor");
  process.exit(
    await superviseBinary({
      binaryPath,
      args: Bun.argv.slice(2),
      startupTimeoutMs: 10_000,
      pollMs: 10,
      log: (message) => event("log", { message }),
    }),
  );
} else {
  event("child");
  const web = new EmbeddedWebProcess({ env: process.env, log: (message) => event("log", { message }) });

  let updates: GatewayUpdates | undefined;

  const restart = async (exitCode = UPDATE_RESTART_EXIT_CODE) => {
    event("stopped", { exitCode });
    await web.stop();
    updates?.close();
    process.exit(exitCode);
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void restart(0));

  updates = new GatewayUpdates({
    kind: "binary",
    version: CANOPY_VERSION,
    binaryPath,
    cacheDir: join(directory, "cache"),
    source: {
      fetch: async () => {
        throw new Error("offline fixture");
      },
    },
    authenticate: async () => undefined,
    persistence: {
      admin: async () => true,
      channel: async () => undefined,
      setChannel: async () => {},
      workers: async () => [],
      hello: async () => {},
      saveCommand: async () => {},
      report: async () => {},
    },
    idle: async () => true,
    restart,
  });
  onSupervisorHandover(
    () => updates!.handover(),
    (message) => event("log", { message }),
  );

  // As in gateway.ts: the web must be healthy before this version confirms its startup.
  try {
    await web.start();
  } catch (error) {
    event("web-failed", { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  await updates.start();
  event("healthy");
  setInterval(() => {
    void readFile(join(directory, "restart"), "utf8").then(
      async () => {
        await rm(join(directory, "restart"));
        await restart();
      },
      () => {},
    );
  }, 20);
}
