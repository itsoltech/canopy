import { createHash } from "node:crypto";
import { join } from "node:path";
import { environmentDigest } from "@canopy/domain/agent-environment";
import {
  copyChanged,
  sameSkillEntry,
  withSkillDirectory,
  type SkillDirectory,
  type SkillEntry,
} from "./skill-directory.ts";

export const SKILL_INVENTORY_ENTRY_LIMIT = 4096;
const archiveDirectory = ".canopy-skill-archive";

export interface InventoryBudget {
  remaining: number;
}

export function inspectSkillCopy(
  parent: SkillDirectory,
  name: string,
  targetId: string,
  budget: InventoryBudget,
  onChild?: (directory: SkillDirectory, name: string, entry: SkillEntry, path: string) => void,
) {
  const root = parent.entry(name);

  if (!root || !(root.kind === "directory" || root.kind === "link")) throw copyChanged();
  const hash = createHash("sha256");
  let count = 0;

  const spend = () => {
    if (--budget.remaining < 0) throw new Error("This computer has too many skill files to preview this copy.");
  };

  spend();

  const visit = (directory: SkillDirectory, child: string, entry: SkillEntry, depth: number, prefix: string) => {
    if (++count > SKILL_INVENTORY_ENTRY_LIMIT || depth > 48)
      throw new Error("This copy is too large to verify for removal.");
    hash.update(JSON.stringify([depth, child, entry.kind, entry.identity, entry.version, depth ? entry.changed : ""]));
    const path = depth ? (prefix ? `${prefix}/${child}` : child) : "";

    if (depth) onChild?.(directory, child, entry, path);

    if (entry.kind !== "directory") return;
    const pin = directory.child(child);

    try {
      if (!sameSkillEntry(pin.entry("."), entry)) throw copyChanged();

      for (const leaf of pin.names(SKILL_INVENTORY_ENTRY_LIMIT - count, spend)) {
        const before = pin.entry(leaf);

        if (!before) throw copyChanged();
        visit(pin, leaf, before, depth + 1, path);
      }
    } finally {
      pin.close();
    }

    if (!sameSkillEntry(directory.entry(child), entry)) throw copyChanged();
  };

  visit(parent, name, root, 0, "");
  const digest = hash.digest("hex");
  const token = environmentDigest(JSON.stringify([targetId, parent.entry(".")?.identity, root.changed, digest]));

  return { digest, token, kind: root.kind };
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
      const before = inspectSkillCopy(root, name, targetId, { remaining: SKILL_INVENTORY_ENTRY_LIMIT });

      if (before.token !== expected || !stillPinned(root) || !stillPinned(slot)) throw copyChanged();
      root.move(name, slot);

      try {
        if (!stillPinned(root) || !stillPinned(slot)) throw copyChanged();

        if (inspectSkillCopy(slot, name, targetId, { remaining: SKILL_INVENTORY_ENTRY_LIMIT }).digest !== before.digest)
          throw copyChanged();
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
