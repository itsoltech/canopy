import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

/** Cheap, canonical scan identity before admission; no git subprocess or recursive source walk. */
export function canonicalCheckoutRoot(path: string): string {
  let current = realpathSync(path);
  const original = current;

  while (!existsSync(join(current, ".git"))) {
    const parent = dirname(current);

    if (parent === current) return original;
    current = parent;
  }

  return current;
}

/** Resolve aliases even when the last components of a checkout have not been created or have disappeared. */
export function canonicalPath(path: string): string {
  let ancestor = path;

  for (;;) {
    try {
      return join(realpathSync(ancestor), relative(ancestor, path));
    } catch {
      const parent = dirname(ancestor);

      if (parent === ancestor) return path;
      ancestor = parent;
    }
  }
}
