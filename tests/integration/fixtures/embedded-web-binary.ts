/** Standalone gateway fixture with an embedded web: the real supervisor, update runtime and in-process web server. */
import { appendFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import type { JsonObject } from "@canopy/domain";
import {
  onSupervisorHandover,
  readUpdateRecord,
  rollbackBinary,
  superviseBinary,
  UPDATE_RESTART_EXIT_CODE,
} from "@canopy/updater";
import { GatewayUpdates } from "../../../apps/gateway/src/updates/runtime.ts";
import { EMBEDDED_WEB } from "../../../apps/gateway/src/web/embedded.ts";
import { EmbeddedWebServer } from "../../../apps/gateway/src/web/server.ts";
import { serveEmbeddedWeb } from "../../../apps/gateway/src/web/serve.ts";

// `web` alone keeps only the web's allowlisted environment (web/config.ts): no test directory there.
const directory = process.env["CANOPY_TEST_DIRECTORY"] ?? "";
const binaryPath = join(directory, "installed");

function event(type: string, details: JsonObject = {}) {
  if (!directory) return;
  appendFileSync(
    join(directory, "events.jsonl"),
    JSON.stringify({ type, version: CANOPY_VERSION, pid: process.pid, ...details }) + "\n",
  );
}

if (Bun.argv[2] === "web") {
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

  const web: EmbeddedWebServer = new EmbeddedWebServer({
    archive: EMBEDDED_WEB!,
    env: process.env,
    log: (message) => event("log", { message }),
    hosts: () => (process.env["CANOPY_TEST_RUNTIME_HOSTS"] ?? "").split(",").filter(Boolean),
    changed: () => event("web-state", { state: web.state, reason: web.reason }),
  });

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

  // As in gateway.ts: a candidate's web must be healthy before it confirms; otherwise the gateway runs on.
  const record = await readUpdateRecord(binaryPath);

  await web.start(record?.state === "restarting" && record.version === CANOPY_VERSION).catch(async (cause: unknown) => {
    const reason = `The web app of ${CANOPY_VERSION} didn't start: ${cause instanceof Error ? cause.message : String(cause)}`;
    event("web-failed", { message: reason });
    await rollbackBinary(binaryPath, reason);
    process.exit(UPDATE_RESTART_EXIT_CODE);
  });

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
