import { existsSync, lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isLegacyHardLink } from "../home.ts";

const managedLogins = [
  "codex-home/auth.json",
  "homes/codex-*/auth.json",
  "bots/*/*/home/auth.json",
  "bots/*/conversations/*/*/home/auth.json",
  "text-generation/*/codex-home/auth.json",
].map((pattern) => new Bun.Glob(pattern));

export function isManagedCodexLogin(dataDir: string, home: string): boolean {
  if (!existsSync(dataDir)) return false;

  const relativePath = relative(realpathSync(dataDir), join(realpathSync(home), "auth.json"))
    .split(sep)
    .join("/");

  return managedLogins.some((glob) => glob.match(relativePath));
}

/**
 * Inactive instances and bot conversations can still keep the device file hard-linked.
 * Remove only names we can prove are aliases of a current login in a different location.
 */
export function removeLegacyCodexHardLinks(
  dataDir: string,
  sourceHomes: readonly string[],
  shadowHomes: readonly string[],
  platform = process.platform,
): void {
  if (platform !== "win32") return;
  const sources = new Set<string>();
  let hasHardLink = false;

  for (const home of sourceHomes) {
    try {
      const auth = realpathSync(join(home, "auth.json"));
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

  try {
    const cwd = realpathSync(dataDir);

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
      const canonical = realpathSync(path);

      if (!configured && relative(path, canonical) !== "") continue;

      if (!loginPaths.some((source) => relative(source, canonical) === "") && isLegacyHardLink(canonical, loginPaths))
        unlinkSync(canonical);
    } catch {
      // This may be a removed or inaccessible home. Preparation also reconciles the file when it is next used.
    }
  }
}
