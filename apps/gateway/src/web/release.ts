import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackWeb } from "./archive.ts";
import type { EmbeddedWebArchive } from "./embedded.ts";

/** Releases kept on disk: the running one and the previous ones whose hashed assets open tabs may still load. */
export const WEB_RELEASES_KEPT = 3;
const COMPLETE = ".complete";
const STALE_PARTIAL_MS = 60 * 60 * 1000;

export interface WebRelease {
  /** The extracted build: index.js, chunks, client/. */
  directory: string;
  /** Older retained releases, newest first (their `client/_app/immutable` assets stay reachable). */
  previous: string[];
}

async function writable(root: string, log: (message: string) => void): Promise<string> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const probe = join(root, `.write-${crypto.randomUUID()}`);
    await (await open(probe, "wx", 0o600)).close();
    await rm(probe, { force: true });

    return root;
  } catch {
    const temporary = await mkdtemp(join(tmpdir(), "canopy-web-"));
    log(`web: ${root} is not writable; using ${temporary} (set CANOPY_WEB_DIR to a writable directory)`);

    return temporary;
  }
}

async function completed(root: string): Promise<{ directory: string; used: number }[]> {
  const releases: { directory: string; used: number }[] = [];

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);

    if (entry.name.startsWith(".partial-")) {
      // Left by an interrupted extraction; a running one is younger than this.
      if (Date.now() - (await stat(directory)).mtimeMs > STALE_PARTIAL_MS)
        await rm(directory, { recursive: true, force: true });
      continue;
    }

    if (existsSync(join(directory, COMPLETE)))
      releases.push({ directory, used: (await stat(join(directory, COMPLETE))).mtimeMs });
  }

  return releases.sort((a, b) => b.used - a.used);
}

/**
 * Extracts the embedded build once per version into `<root>/<version>-<key>` (atomic rename of a complete
 * directory), marks it as the latest used and prunes all but WEB_RELEASES_KEPT releases. A running release
 * is never rewritten; a rollback reuses its kept directory.
 */
export async function prepareWebRelease(
  archive: EmbeddedWebArchive,
  root: string,
  log: (message: string) => void,
): Promise<WebRelease> {
  const base = await writable(root, log);
  const directory = join(base, `${archive.version.replace(/[^\w.+-]/g, "_")}-${archive.key}`);

  if (!existsSync(join(directory, COMPLETE))) {
    const partial = join(base, `.partial-${crypto.randomUUID()}`);

    try {
      await mkdir(partial, { mode: 0o755 });
      await unpackWeb(await Bun.file(archive.file).bytes(), partial);
      await Bun.write(join(partial, COMPLETE), JSON.stringify({ version: archive.version }));
      await rm(directory, { recursive: true, force: true });
      await rename(partial, directory);
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  }

  const now = new Date();
  await utimes(join(directory, COMPLETE), now, now);
  const releases = (await completed(base)).map((release) => release.directory).filter((d) => d !== directory);
  const previous = releases.slice(0, WEB_RELEASES_KEPT - 1);

  for (const old of releases.slice(WEB_RELEASES_KEPT - 1)) await rm(old, { recursive: true, force: true });

  return { directory, previous };
}
