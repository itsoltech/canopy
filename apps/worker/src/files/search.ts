import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fuzzyRank } from "@canopy/domain";
import { processKey, runProcess } from "@canopy/process-governor";

/**
 * File search for "@" mentions in the composer (docs/ui-api.md, "Wzmianki"): ranked fuzzy matches of paths inside the
 * thread's folder, never outside it.
 *
 * - In a git work tree: `git ls-files` (tracked, plus untracked files that .gitignore does not exclude), so ignored
 *   build output and dependencies never show up. Directories are the files' parents.
 * - Elsewhere: a bounded walk (MAX_WALK entries, MAX_DEPTH levels) that skips hidden directories, dependency and
 *   build folders and does not follow symlinked directories.
 * - The listing is cached per folder for CACHE_MS (typing in the popup asks again on every key).
 *
 * The same search serves every provider (Codex has fuzzyFileSearch, but Claude-only workers and the new-thread
 * composer, before a provider is picked, need it too; one implementation keeps results the same everywhere).
 */

export interface FileMatchResult {
  readonly path: string;
  readonly isDir: boolean;
  readonly indices: readonly number[];
}

export interface FileSearchOutput {
  readonly matches: FileMatchResult[];
  readonly truncated: boolean;
  readonly source: "git" | "walk";
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Paths kept from git (a huge monorepo still answers fast); more = truncated. */
export const MAX_FILES = 100_000;
export const MAX_WALK = 20_000;
export const MAX_DEPTH = 12;
const CACHE_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;

const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "__pycache__",
  "venv",
  ".venv",
  "vendor",
]);

interface Listing {
  readonly entries: { readonly path: string; readonly isDir: boolean }[];
  readonly truncated: boolean;
  readonly source: "git" | "walk";
  readonly at: number;
}

const cache = new Map<string, Listing>();

/** `cwd` must already be validated as an existing absolute directory (WorkerHost). */
export async function searchFiles(
  cwd: string,
  query: string,
  limit = DEFAULT_LIMIT,
  now = Date.now(),
): Promise<FileSearchOutput> {
  const root = realpathSync(cwd);
  let listing = cache.get(root);

  if (!listing || now - listing.at > CACHE_MS) {
    listing = (await gitListing(root, now)) ?? walkListing(root, now);
    cache.set(root, listing);

    if (cache.size > 64) cache.delete(cache.keys().next().value ?? "");
  }

  const max = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (!query.trim()) {
    // Nothing typed yet: the shallowest entries first (the folder's top level), directories before files.
    const top = [...listing.entries].sort(
      (a, b) => depth(a.path) - depth(b.path) || Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path),
    );

    return {
      matches: top.slice(0, max).map((e) => ({ ...e, indices: [] })),
      truncated: listing.truncated,
      source: listing.source,
    };
  }

  const ranked = fuzzyRank(query, listing.entries, (e) => [e.path], max);

  return {
    matches: ranked.map(({ item, match }) => ({ ...item, indices: match.indices })),
    truncated: listing.truncated,
    source: listing.source,
  };
}

/** Forgets cached listings (tests). */
export function clearFileSearchCache(): void {
  cache.clear();
}

function depth(path: string): number {
  return path.split("/").length;
}

async function gitListing(root: string, now: number): Promise<Listing | undefined> {
  try {
    const command = {
      argv: ["git", "-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    };

    const result = await runProcess(command, { kind: "git", key: processKey(command), ttlMs: 1_000 });
    const out = result.stdout;

    if (result.code !== 0) return undefined; // not a git work tree
    const files = [...new Set(out.split("\0").filter(Boolean))];
    const truncated = files.length > MAX_FILES;
    const kept = files.slice(0, MAX_FILES);
    const dirs = new Set<string>();

    for (const file of kept) {
      for (let i = file.indexOf("/"); i >= 0; i = file.indexOf("/", i + 1)) dirs.add(file.slice(0, i));
    }

    return {
      entries: [...[...dirs].map((path) => ({ path, isDir: true })), ...kept.map((path) => ({ path, isDir: false }))],
      truncated,
      source: "git",
      at: now,
    };
  } catch {
    return undefined;
  }
}

function walkListing(root: string, now: number): Listing {
  const entries: { path: string; isDir: boolean }[] = [];
  let truncated = false;
  // Breadth first: a cut-off listing still has the shallow paths.
  const queue: { dir: string; level: number }[] = [{ dir: root, level: 0 }];

  while (queue.length > 0) {
    const { dir, level } = queue.shift()!;
    let names: string[];

    try {
      names = readdirSync(dir).sort();
    } catch {
      continue; // no permission
    }

    for (const name of names) {
      if (entries.length >= MAX_WALK) {
        truncated = true;

        return { entries, truncated, source: "walk", at: now };
      }

      const full = join(dir, name);
      let isDir = false;

      try {
        // lstat: a symlinked directory is listed as an entry but never entered (it may point outside the folder).
        const stat = lstatSync(full);
        isDir = stat.isDirectory();
      } catch {
        continue;
      }

      const path = relative(root, full).split(sep).join("/");

      if (isDir && (name.startsWith(".") || SKIPPED_DIRS.has(name))) continue;
      entries.push({ path, isDir });

      if (isDir) {
        if (level + 1 < MAX_DEPTH) queue.push({ dir: full, level: level + 1 });
        else truncated = true;
      }
    }
  }

  return { entries, truncated, source: "walk", at: now };
}
