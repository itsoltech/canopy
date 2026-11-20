import { lstatSync, unlinkSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

const KEEP_MS = 7 * 24 * 3600_000;
const CACHE_FILE = /^[0-9a-f]{64}(?:\.\d+\.tmp)?$/;

export async function expiredPreviews(dir: string, now: number, signal: AbortSignal): Promise<string[]> {
  const expired: string[] = [];

  for await (const entry of await opendir(dir)) {
    if (signal.aborted) break;

    if (!entry.isFile() || !CACHE_FILE.test(entry.name)) continue;
    const metadata = await lstat(join(dir, entry.name)).catch(() => undefined);

    if (metadata?.isFile() && now - metadata.mtimeMs > KEEP_MS) expired.push(entry.name);
  }

  return expired;
}

export function removeExpiredPreviews(
  dir: string,
  candidates: readonly string[],
  retained: ReadonlySet<string>,
  now: number,
): void {
  for (const candidate of candidates) {
    if (retained.has(candidate.slice(0, 64))) continue;
    const path = join(dir, candidate);

    try {
      const metadata = lstatSync(path);

      if (!metadata.isFile() || now - metadata.mtimeMs <= KEEP_MS) continue;
      unlinkSync(path);
    } catch {
      // The entry is gone or cannot be removed; a later sweep can retry.
    }
  }
}
