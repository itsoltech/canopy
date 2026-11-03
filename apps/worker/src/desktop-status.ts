import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readEnv } from "@canopy/domain/env";

/** Optional status sink for the desktop supervisor; never contains credentials or provider output. */
export function desktopStatus(status: "connecting" | "online" | "offline") {
  const path = readEnv("CANOPY_WORKER_STATUS_FILE");
  if (!path) return;
  try {
    writeFileSync(`${path}.new`, JSON.stringify({ status, time: Date.now() }), { mode: 0o600 });
    renameSync(`${path}.new`, path);
  } catch { /* Status reporting must not interrupt the worker link. */ }
}

/** Whether the status file reports a live gateway link (the worker image's health check). */
export function workerOnline(env: Readonly<Record<string, string | undefined>>): boolean {
  const path = readEnv("CANOPY_WORKER_STATUS_FILE", env);
  if (!path) return false;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { status?: unknown }).status === "online";
  } catch { return false; }
}
