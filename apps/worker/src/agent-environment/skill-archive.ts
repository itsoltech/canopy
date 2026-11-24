import { createHash } from "node:crypto";
import { join } from "node:path";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { withSkillDirectory, type SkillDirectory, type SkillEntry } from "./skill-directory.ts";

const changed = () => new Error("This copy changed. Refresh the list and review it again.");
const maxEntries = 4096;
const archiveDirectory = ".canopy-skill-archive";

export interface InventoryBudget {
  remaining: number;
}

export function inspectSkillCopy(parent: SkillDirectory, name: string, targetId: string, budget: InventoryBudget) {
  const root = parent.entry(name);

  if (!root || !(root.kind === "directory" || root.kind === "link")) throw changed();
  const hash = createHash("sha256");
  let count = 0;

  const spend = () => {
    if (--budget.remaining < 0) throw new Error("This computer has too many skill files to preview this copy.");
  };

  spend();

  const visit = (directory: SkillDirectory, child: string, entry: SkillEntry, depth: number) => {
    if (++count > maxEntries || depth > 48) throw new Error("This copy is too large to verify for removal.");
    hash.update(JSON.stringify([depth, child, entry.kind, entry.identity, entry.version, depth ? entry.changed : ""]));

    if (entry.kind !== "directory") return;
    const pin = directory.child(child);

    try {
      for (const leaf of pin.names(maxEntries - count, spend)) {
        const before = pin.entry(leaf);

        if (!before) throw changed();
        visit(pin, leaf, before, depth + 1);
      }
    } finally {
      pin.close();
    }

    const after = directory.entry(child);

    if (after?.identity !== entry.identity || after.version !== entry.version || after.changed !== entry.changed)
      throw changed();
  };

  visit(parent, name, root, 0);
  const digest = hash.digest("hex");
  const token = environmentDigest(JSON.stringify([targetId, parent.entry(".")?.identity, root.changed, digest]));

  return { digest, token };
}

/** The entry is renamed without replacement on the same volume. Check the captured tree again at its
 * new location: rename can change the entry's ctime, but its identity and every child's version must match.
 */
export function archiveSkillCopy(
  home: SkillDirectory,
  root: SkillDirectory,
  name: string,
  targetId: string,
  expected: string,
): void {
  const archive = home.child(archiveDirectory, true);

  try {
    const slot = archive.child(expected, true);

    try {
      if (slot.entry(".archived")) throw new Error("This removal was already completed. Review the current copy.");
      const before = inspectSkillCopy(root, name, targetId, { remaining: maxEntries });

      if (before.token !== expected || !stillPinned(root) || !stillPinned(slot)) throw changed();
      root.move(name, slot);

      try {
        if (!stillPinned(root) || !stillPinned(slot)) throw changed();

        if (inspectSkillCopy(slot, name, targetId, { remaining: maxEntries }).digest !== before.digest) throw changed();
        // Remember a consumed preview even after a manual restore on a filesystem with coarse timestamps.
        slot.child(".archived", true).close();
      } catch (error) {
        try {
          slot.move(name, root);
        } catch {
          throw new Error(`The copy changed during removal. Recover it from ${join(slot.path, name)}.`);
        }

        throw error;
      }
    } finally {
      slot.close();
    }
  } finally {
    archive.close();
  }
}

function stillPinned(directory: SkillDirectory): boolean {
  const identity = directory.entry(".")?.identity;

  return !!identity && withSkillDirectory(directory.path, (current) => current.entry(".")?.identity) === identity;
}
