import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isWithin } from "../git/worktrees.ts";

/** New files must resolve under an existing workspace ancestor; broken links never qualify. */
export function workspaceEdit(cwd: string, path: string): boolean {
  if (!path || path.includes("\0") || path.split(/[\\/]/).includes("..")) return false;

  try {
    const root = realpathSync(cwd);
    let target = isAbsolute(path) ? path : resolve(cwd, path);

    if (process.platform === "win32" && target.slice(2).includes(":")) return false;

    for (;;) {
      if (lstatSync(target, { throwIfNoEntry: false })) return isWithin(root, realpathSync(target));
      const parent = dirname(target);

      if (parent === target) return false;
      target = parent;
    }
  } catch {
    return false;
  }
}
