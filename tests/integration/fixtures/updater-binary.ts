/** Real standalone process fixture: shared watchdog and production worker/gateway drain paths. */
import { appendFileSync, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import {
  clearUpdateResult,
  confirmStartup,
  onSupervisorHandover,
  readUpdateRecord,
  superviseBinary,
  UPDATE_RESTART_EXIT_CODE,
} from "@canopy/updater";
import { WorkerUpdates } from "../../../apps/worker/src/update-link.ts";
import type { JsonObject } from "@canopy/domain";
import { GatewayUpdates } from "../../../apps/gateway/src/updates/runtime.ts";

const directory = process.env["CANOPY_TEST_DIRECTORY"]!;
const binaryPath = join(directory, "installed");

function event(type: string, details: JsonObject = {}) {
  appendFileSync(
    join(directory, "events.jsonl"),
    JSON.stringify({ type, version: CANOPY_VERSION, pid: process.pid, ...details }) + "\n",
  );
}

if (!process.env["CANOPY_SUPERVISED"]) {
  event("supervisor", { args: Bun.argv.slice(2) });

  if (process.env["CANOPY_TEST_EXECVE"] === "throws")
    process.execve = () => {
      throw new Error("fixture execve failure");
    };

  process.exit(
    await superviseBinary({
      binaryPath,
      args: Bun.argv.slice(2),
      startupTimeoutMs: 600,
      pollMs: 10,
      log: (message) => event("log", { message }),
    }),
  );
}

event("child", { parent: process.ppid });

let active =
  process.env["CANOPY_TEST_BUSY_VERSION"] === CANOPY_VERSION && !existsSync(join(directory, "turn-finished"));

let draining = false;
let updates: WorkerUpdates | GatewayUpdates;
const stopping = new AbortController();

const drain = (value: boolean) => {
  draining = value;
  event("drain", { value, active });
};

const restart = async (exitCode = UPDATE_RESTART_EXIT_CODE) => {
  event("stopped", { exitCode, active, draining });
  stopping.abort();

  if (updates instanceof GatewayUpdates) updates.close();
  process.exit(exitCode);
};

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void restart(0);
  });

if (CANOPY_VERSION === "4.0.0") {
  const failure = process.env["CANOPY_TEST_FAILURE"] ?? "23";

  if (failure !== "timeout") process.exit(Number(failure));
  setInterval(() => {}, 1000);
} else {
  if (process.env["CANOPY_TEST_APP"] === "gateway") {
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
      idle: async () => !active,
      drain,
      restart,
    });
    onSupervisorHandover(
      () => updates.handover(),
      (message) => event("log", { message }),
    );
    await updates.start();
  } else {
    updates = new WorkerUpdates({
      kind: "binary",
      version: CANOPY_VERSION,
      binaryPath,
      baseUrl: "https://worker.fixture",
      credential: "fixture",
      workerId: "fixture",
      signal: stopping.signal,
      idle: () => !active,
      drain,
      restart,
    });
    onSupervisorHandover(
      () => updates.handover(),
      (message) => event("log", { message }),
    );
    await confirmStartup(binaryPath);
  }

  // Exercise the real race: the progress reporter may consume success before the supervisor's next poll.
  if ((await readUpdateRecord(binaryPath))?.state === "succeeded") await clearUpdateResult(binaryPath);
  event("healthy");
  let checking = false;
  setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      const path = join(directory, "command.json");
      let command: { idle?: boolean; restart?: boolean };

      try {
        command = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
        throw error;
      }

      await rm(path);

      if (command.idle) {
        await writeFile(join(directory, "turn-finished"), "");
        active = false;
        event("turn-finished");
      }

      if (command.restart) await restart();
    })()
      .catch((cause: unknown) => {
        event("error", { error: String(cause) });
        process.exit(1);
      })
      .finally(() => {
        checking = false;
      });
  }, 10);
}
