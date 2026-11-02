import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IDS = new RegExp(`^(${ID})[/\\\\](${ID})$`, "i");
const LEGACY = new RegExp(`^(.*)[/\\\\]\\.open-agents[/\\\\]scratch[/\\\\](${ID})[/\\\\](${ID})$`, "i");
const PREVIOUS = new RegExp(`^(.*)[/\\\\]scratch[/\\\\](${ID})[/\\\\](${ID})$`, "i");

/** Idempotent CreateThread preparation. Never follows symlinks in the managed subtree.
 * Existing legacy threads retain their stored cwd under .open-agents/scratch.
 * No automatic cleanup: forks and side threads can still be using this directory.
 */
export function ensureScratchDirectory(cwd: string, scratchRoot: string): void {
  if (!isAbsolute(cwd)) throw new Error("invalid scratch directory: path must be absolute");
  const match = IDS.exec(relative(scratchRoot, cwd));
  const legacy = !match ? LEGACY.exec(cwd) : undefined;
  const previous = !match && !legacy ? PREVIOUS.exec(cwd) : undefined;
  if (!match && !legacy && !previous) throw new Error("invalid scratch directory: expected <data_dir>/scratch/<owner-id>/<thread-id>");
  // A previous scratch base remains valid only for an existing thread directory.
  // Never recreate missing legacy trees elsewhere on the machine.
  if (legacy || previous) realpathSync(cwd);
  const existing = legacy ?? previous;
  let parent = realpathSync(existing ? existing[1] || "/" : join(scratchRoot, ".."));
  const segments = legacy ? [".open-agents", "scratch", legacy[2]!, legacy[3]!] : ["scratch", ...(previous ? [previous[2]!, previous[3]!] : [match![1]!, match![2]!])];
  for (const segment of segments) {
    // Validate each parent before creating its child, so an existing symlink cannot cause
    // recursive mkdir to write through a symlink before the final cwd check.
    const next = join(parent, segment);
    try { mkdirSync(next, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("scratch directory components must be real directories");
    parent = realpathSync(next);
  }
}
