import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isAllowedPath } from "../config/remote.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SCRATCH = new RegExp(`^(.*)[/\\\\]\\.open-agents[/\\\\]scratch[/\\\\](${ID})[/\\\\](${ID})$`, "i");

/** Idempotent CreateThread preparation. Never follows symlinks in the managed subtree.
 * The configured root itself may be a symlink (the config resolves those already).
 * No automatic cleanup: forks and side threads can still be using this directory.
 */
export function ensureScratchDirectory(cwd: string, allowedRoots: readonly string[]): void {
  const match = SCRATCH.exec(cwd);
  if (!match || !isAbsolute(cwd)) throw new Error("invalid scratch directory: expected .open-agents/scratch/<owner-id>/<thread-id>");
  let parent = realpathSync(match[1] || "/");
  if (!isAllowedPath({ allowedRoots }, parent)) throw new Error("scratch directory is outside the allowed roots");
  for (const segment of [".open-agents", "scratch", match[2]!, match[3]!]) {
    // Validate each parent before creating its child, so an existing symlink cannot cause
    // recursive mkdir to write outside the allowed roots before the final cwd check.
    const next = join(parent, segment);
    try { mkdirSync(next, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("scratch directory components must be real directories");
    parent = realpathSync(next);
    if (!isAllowedPath({ allowedRoots }, parent)) throw new Error("scratch directory is outside the allowed roots");
  }
}
