import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Schema } from "effect";
import { createInterface } from "node:readline";

const StatusFile = Schema.Struct({ status: Schema.optionalKey(Schema.String) });

/** Optional status sink for the desktop supervisor; never contains credentials or provider output. */
let updateIdle = false;
let updateDraining = false;

export function desktopStatus(status: "connecting" | "online" | "offline") {
  const path = process.env["CANOPY_WORKER_STATUS_FILE"];

  if (!path) return;

  try {
    writeFileSync(
      `${path}.new`,
      JSON.stringify({ status, time: Date.now(), pid: process.pid, idle: updateIdle, draining: updateDraining }),
      { mode: 0o600 },
    );
    renameSync(`${path}.new`, path);
  } catch {
    /* Status reporting must not interrupt the worker link. */
  }
}

/** Private stdin of the bundled worker. No network credential or binary replacement. */
export function desktopDrain(options: { idle(): Promise<boolean>; drain(value: boolean): void; online(): boolean }) {
  if (!process.env["CANOPY_WORKER_STATUS_FILE"] || process.env["CANOPY_INSTALL_KIND"] !== "desktop") return;
  const lines = createInterface({ input: process.stdin });
  let revision = 0;
  lines.on("line", (line) => {
    if (line !== "canopy:drain" && line !== "canopy:resume") return;
    updateDraining = line === "canopy:drain";
    revision++;
    updateIdle = false;
    options.drain(updateDraining);
  });
  let checking = false;

  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    const started = revision;
    void options
      .idle()
      .then((idle) => {
        if (started !== revision) return;
        updateIdle = idle;
        desktopStatus(options.online() ? "online" : "connecting");
      })
      .catch(() => {
        updateIdle = false;
      })
      .finally(() => {
        checking = false;
      });
  }, 500);

  timer.unref();
  process.once("exit", () => {
    clearInterval(timer);
    lines.close();
  });
}

/** Whether the status file reports a live gateway link (the worker image's health check). */
export function workerOnline(env: Readonly<Record<string, string | undefined>>): boolean {
  const path = env["CANOPY_WORKER_STATUS_FILE"];

  if (!path) return false;

  try {
    return Schema.decodeUnknownSync(StatusFile)(JSON.parse(readFileSync(path, "utf8"))).status === "online";
  } catch {
    return false;
  }
}
