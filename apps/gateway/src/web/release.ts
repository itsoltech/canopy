import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackWeb } from "./archive.ts";
import type { EmbeddedWebArchive } from "./embedded.ts";

/** Releases kept on disk: the running one and the previous ones whose hashed assets open tabs may still load. */
export const WEB_RELEASES_KEPT = 3;
const COMPLETE = ".complete";

/** A running web touches its release this often; anything touched within IN_USE_MS is never pruned. */
export const TOUCH_MS = 10 * 60 * 1000;

const IN_USE_MS = 3 * TOUCH_MS;
const STALE_PARTIAL_MS = 60 * 60 * 1000;

export interface WebRelease {
  /** The extracted build: index.js, chunks, client/. */
  directory: string;
  /** Older retained releases, newest first (their `client/_app/immutable` assets stay reachable). */
  previous: string[];
}

async function writable(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const probe = join(directory, `.write-${crypto.randomUUID()}`);
    await (await open(probe, "wx", 0o600)).close();
    await rm(probe, { force: true });

    return true;
  } catch {
    return false;
  }
}

/** CANOPY_WEB_DIR when writable, else one fixed private directory per user (reused, so nothing piles up). */
async function root(configured: string, log: (message: string) => void): Promise<string> {
  if (await writable(configured)) return configured;
  const fallback = join(tmpdir(), `canopy-web-${process.getuid?.() ?? "user"}`);

  if (!(await writable(fallback))) throw new Error(`Neither ${configured} nor ${fallback} is writable for the web`);
  log(`web: ${configured} is not writable; using ${fallback} (set CANOPY_WEB_DIR to a writable directory)`);

  return fallback;
}

async function completed(base: string): Promise<{ directory: string; used: number }[]> {
  const releases: { directory: string; used: number }[] = [];

  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(base, entry.name);

    if (entry.name.startsWith(".partial-")) {
      // Left by an interrupted extraction; a running one is younger than this.
      if (Date.now() - (await stat(directory)).mtimeMs > STALE_PARTIAL_MS)
        await rm(directory, { recursive: true, force: true });
      continue;
    }

    const marker = await stat(join(directory, COMPLETE)).catch(() => undefined);

    if (marker) releases.push({ directory, used: marker.mtimeMs });
  }

  return releases.sort((a, b) => b.used - a.used);
}

/** Unpacks next to the target and renames it into place; another instance finishing first is success too. */
async function extract(archive: EmbeddedWebArchive, base: string, directory: string): Promise<void> {
  const partial = join(base, `.partial-${crypto.randomUUID()}`);

  try {
    await mkdir(partial, { mode: 0o755 });
    await unpackWeb(await Bun.file(archive.file).bytes(), partial);
    await Bun.write(join(partial, COMPLETE), JSON.stringify({ version: archive.version }));

    try {
      await rename(partial, directory);
    } catch (error) {
      if (existsSync(join(directory, COMPLETE))) return;
      // An interrupted earlier extraction left an incomplete directory under this name: never a running release.
      await rm(directory, { recursive: true, force: true });
      await rename(partial, directory).catch((cause: unknown) => {
        if (!existsSync(join(directory, COMPLETE))) throw cause instanceof Error ? cause : error;
      });
    }
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}

/** Marks a release as in use (start, and every TOUCH_MS while it runs) so no other instance prunes it. */
export async function touchWebRelease(directory: string): Promise<void> {
  const now = new Date();
  await utimes(join(directory, COMPLETE), now, now);
}

/**
 * Extracts the embedded build once per version into `<root>/<version>-<key>`, marks it as used and prunes
 * releases beyond WEB_RELEASES_KEPT that nobody used recently. A completed release is never rewritten, so
 * several instances may share the directory; a rollback reuses its kept directory.
 */
export async function prepareWebRelease(
  archive: EmbeddedWebArchive,
  configured: string,
  log: (message: string) => void,
): Promise<WebRelease> {
  const base = await root(configured, log);
  const directory = join(base, `${archive.version.replace(/[^\w.+-]/g, "_")}-${archive.key}`);

  if (!existsSync(join(directory, COMPLETE))) await extract(archive, base, directory);
  await touchWebRelease(directory);
  const others = (await completed(base)).filter((release) => release.directory !== directory);
  const previous = others.slice(0, WEB_RELEASES_KEPT - 1).map((release) => release.directory);

  for (const old of others.slice(WEB_RELEASES_KEPT - 1))
    if (Date.now() - old.used > IN_USE_MS) await rm(old.directory, { recursive: true, force: true });

  return { directory, previous };
}
