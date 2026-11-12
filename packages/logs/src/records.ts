import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { LOG_LIMITS } from "./limits.ts";

/** Reverse bounded records: an unfinished last record and oversized records are omitted as a whole. */
export async function* reverseRecords(path: string, budget: { remaining: number }, signal: AbortSignal) {
  const identity = await lstat(path);

  if (!identity.isFile() || identity.isSymbolicLink()) throw new Error("Log source must be a regular file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = await file.stat();

    if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("Log source changed while opening");

    if (!stat.isFile() || stat.mtimeMs < Date.now() - LOG_LIMITS.retentionMs) return;
    let position = stat.size;
    let pending = Buffer.alloc(0);
    let pendingBytes = 0;
    let dropping = false;
    let unfinished = true;

    while (position > 0 && budget.remaining > 0) {
      const cpu = process.cpuUsage();
      signal.throwIfAborted();
      const size = Math.min(LOG_LIMITS.chunk, position, budget.remaining);
      const data = Buffer.allocUnsafe(size);
      position -= size;
      budget.remaining -= size;
      const { bytesRead } = await file.read(data, 0, size, position);

      if (bytesRead !== size) throw new Error("Log source changed while reading");
      let end = data.length;

      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 10) continue;
        const part = data.subarray(index + 1, end);
        const bytes = part.length + pendingBytes;

        if (bytes || dropping) {
          const line = unfinished || dropping || bytes > LOG_LIMITS.line ? undefined : Buffer.concat([part, pending]);
          yield { line, bytes };
        }

        unfinished = false;
        dropping = false;
        pending = Buffer.alloc(0);
        pendingBytes = 0;
        end = index;
      }

      pendingBytes += end;

      if (pendingBytes > LOG_LIMITS.line) {
        pending = Buffer.alloc(0);
        dropping = true;
      } else if (!dropping) pending = Buffer.concat([data.subarray(0, end), pending]);
      const used = process.cpuUsage(cpu);
      await delay(Math.max(2, Math.ceil(((used.user + used.system) * 9) / 1000)), undefined, { signal });
    }

    if (pendingBytes || dropping)
      yield { line: position === 0 && !dropping && !unfinished ? pending : undefined, bytes: pendingBytes };
  } finally {
    await file.close();
  }
}
