import { existsSync, lstatSync, readlinkSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { archiveLogin, isLegacyHardLink } from "../home.ts";
import { resolveLoginPath } from "../home-paths.ts";

const managedLogins = ["codex-home/auth.json", "homes/codex-*/auth.json", "text-generation/*/codex-home/auth.json"].map(
  (pattern) => new Bun.Glob(pattern),
);

const botHomes = ["bots/*/*/home", "bots/*/conversations/*/*/home"].map((pattern) => new Bun.Glob(pattern));
const instanceHomes = new Bun.Glob("homes/codex-*");

function relativeGlobPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function isManagedCodexLogin(dataDir: string, home: string): boolean {
  if (!existsSync(dataDir)) return false;

  const relativePath = relativeGlobPath(realpathSync(dataDir), join(realpathSync(home), "auth.json"));

  return managedLogins.some((glob) => glob.match(relativePath));
}

function botLoginSources(sourceHomes: readonly string[]): string[] {
  const sources = new Set<string>();

  for (const source of sourceHomes) {
    if (!source) continue;
    sources.add(resolve(source));

    try {
      sources.add(realpathSync(source));
    } catch {
      // The original path still identifies symbolic links to a missing login home.
    }
  }

  return [...sources];
}

function removeBotLoginLinks(home: string, sources: readonly string[]): void {
  if (sources.some((source) => relative(home, source) === "")) return;

  for (const file of ["auth.json", "auth.lock"]) {
    const target = join(home, file);
    const current = lstatSync(target, { throwIfNoEntry: false });

    if (!current) continue;

    const candidates = sources.map((source) => join(source, file));
    const link = current.isSymbolicLink() ? resolve(home, readlinkSync(target)) : undefined;

    const linked = link
      ? candidates.some((candidate) => relative(link, candidate) === "")
      : current.isFile() && isLegacyHardLink(target, candidates);

    if (linked) unlinkSync(target);
  }
}

/** Keep legacy credentials out of every bot child, including model discovery before login. */
export function cleanLegacyCodexBotLogin(home: string, sourceHomes: readonly string[]): void {
  const path = realpathSync(home);
  const sources = botLoginSources(sourceHomes);

  if (sources.some((source) => relative(path, source) === ""))
    throw new Error("The Codex bot home must be separate from all provider login homes.");

  removeBotLoginLinks(path, sources);

  for (const file of ["auth.json", "auth.lock"]) {
    const target = join(path, file);
    const stat = lstatSync(target, { throwIfNoEntry: false });

    if (!stat || (file === "auth.lock" && stat.isFile())) continue;

    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Unexpected file in the Codex bot login path.");
    archiveLogin(target, Bun.randomUUIDv7());
  }
}

export function migrateLegacyCodexBotLogins(dataDir: string, sourceHomes: readonly string[]): void {
  try {
    const cwd = realpathSync(dataDir);
    const scan = { cwd, absolute: true, followSymlinks: false, onlyFiles: false };
    // The instance may have been removed before the worker next applied configuration.
    // A stored link can use the configured spelling of dataDir (e.g. an OS temp-directory alias).
    const knownInstances = Array.from(instanceHomes.scanSync(scan), (home) => join(dataDir, relative(cwd, home)));
    const sources = botLoginSources([...sourceHomes, ...knownInstances]);

    for (const glob of botHomes) {
      for (const home of glob.scanSync(scan)) {
        try {
          if (lstatSync(home).isDirectory() && relative(home, realpathSync(home)) === "")
            removeBotLoginLinks(home, sources);
        } catch {
          // An inaccessible home can be reconciled when its bot next runs.
        }
      }
    }
  } catch {
    // The worker directory may not exist yet or may be temporarily inaccessible.
  }
}

/**
 * Inactive instance homes can still keep the device file hard-linked.
 * Reconcile only names we can prove are aliases of a current login in a different location.
 */
export function migrateLegacyCodexHardLinks(
  dataDir: string,
  sourceHomes: readonly string[],
  shadowHomes: readonly string[],
  replace: (home: string, auth: string) => boolean,
): void {
  const sources = new Set<string>();
  let hasHardLink = false;

  for (const home of sourceHomes) {
    try {
      const auth = resolveLoginPath(join(home, "auth.json"));
      const stat = statSync(auth, { bigint: true });

      if (stat.isFile()) {
        sources.add(auth);
        hasHardLink ||= stat.nlink > 1n;
      }
    } catch {
      // No current credential file for this source.
    }
  }

  if (!hasHardLink) return;

  const candidates = new Map(shadowHomes.map((home) => [resolve(home, "auth.json"), true]));

  let cwd = resolve(dataDir);

  try {
    cwd = realpathSync(dataDir);

    for (const glob of managedLogins)
      for (const path of glob.scanSync({ cwd, absolute: true, followSymlinks: false }))
        if (!candidates.has(path)) candidates.set(path, false);
  } catch {
    // Keep checking configured paths if the worker directory cannot be scanned.
  }

  const loginPaths = [...sources];

  for (const [path, configured] of candidates) {
    try {
      if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      const canonical = resolveLoginPath(path);

      if (!configured && relative(path, canonical) !== "") continue;

      if (botHomes.some((glob) => glob.match(relativeGlobPath(cwd, dirname(canonical))))) continue;

      if (loginPaths.some((source) => relative(source, canonical) === "") || !isLegacyHardLink(canonical, loginPaths))
        continue;

      if (!replace(dirname(path), canonical)) unlinkSync(canonical);
    } catch {
      // This may be a removed or inaccessible home. Preparation also reconciles the file when it is next used.
    }
  }
}
