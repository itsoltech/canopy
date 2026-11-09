import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Metadata only: resolve aliases and stop at the nearest .git, including nested repositories. */
export function matchingCheckoutPaths(root: string, paths: readonly string[]): string[] {
  const roots = new Map<string, string>();

  function checkout(path: string): string {
    const cached = roots.get(path);

    if (cached !== undefined) return cached;
    const parent = dirname(path);
    const result = existsSync(join(path, ".git")) ? path : parent === path ? "" : checkout(parent);
    roots.set(path, result);

    return result;
  }

  return paths.filter((path) => {
    try {
      return checkout(realpathSync(path)) === root;
    } catch {
      return false;
    }
  });
}
