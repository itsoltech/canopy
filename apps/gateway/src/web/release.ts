import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
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

export interface WebRelease {
  /** The directory of all extracted releases (CANOPY_WEB_DIR or its private fallback). */
  base: string;
  /** The extracted build: index.js, handler.js, chunks, client/. */
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

/**
 * One fixed directory per user in the shared temporary directory, reused so nothing piles up. The web imports
 * code from it, so it must be a real directory of this user with mode 0700: anything else (created first by
 * another user, a symlink, wider permissions) is never used, and a fresh private mkdtemp directory replaces it.
 */
async function privateFallback(log: (message: string) => void): Promise<string> {
  const uid = process.getuid?.();
  const fixed = join(tmpdir(), `canopy-web-${uid ?? "user"}`);

  await mkdir(fixed, { mode: 0o700 }).catch((cause: unknown) => {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  });
  const info = await lstat(fixed);

  if (
    info.isDirectory() &&
    (process.platform === "win32" || (info.uid === uid && (info.mode & 0o777) === 0o700)) &&
    (await writable(fixed))
  )
    return fixed;
  log(`web: ${fixed} is not a private directory of this user; not using it`);

  return mkdtemp(join(tmpdir(), "canopy-web-"));
}

/** CANOPY_WEB_DIR when writable, else a private directory in the temporary directory. */
async function root(configured: string, log: (message: string) => void): Promise<string> {
  if (await writable(configured)) return configured;
  const fallback = await privateFallback(log);
  log(`web: ${configured} is not writable; using ${fallback} (set CANOPY_WEB_DIR to a writable directory)`);

  return fallback;
}

async function completed(base: string): Promise<{ directory: string; used: number }[]> {
  const releases: { directory: string; used: number }[] = [];

  for (const entry of await readdir(base, { withFileTypes: true })) {
    // Extractions in progress (another instance's included) are not releases; each removes only its own.
    if (!entry.isDirectory() || entry.name.startsWith(".partial-")) continue;
    const directory = join(base, entry.name);

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

    // The release only ever appears complete (its marker is written before this rename), so a failed rename
    // means another instance got there first, or a real error; the existing directory is never removed.
    await rename(partial, directory).catch((cause: unknown) => {
      if (!existsSync(join(directory, COMPLETE))) throw cause;
    });
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

  return { base, directory, previous };
}
