import { renameSync, writeFileSync } from "node:fs";

/** Optional status sink for the desktop supervisor; never contains credentials or provider output. */
export function desktopStatus(status: "connecting" | "online" | "offline") {
  const path = Bun.env["OA_WORKER_STATUS_FILE"];
  if (!path) return;
  try {
    writeFileSync(`${path}.new`, JSON.stringify({ status, time: Date.now() }), { mode: 0o600 });
    renameSync(`${path}.new`, path);
  } catch { /* Status reporting must not interrupt the worker link. */ }
}
