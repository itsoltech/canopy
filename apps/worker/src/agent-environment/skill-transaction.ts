import { existsSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import type { SkillFile } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { readInstructionFile, replaceInstructionFile } from "./files.ts";
import type { SkillLedger, ManagedSkill } from "./skill-ledger.ts";
import { readSkillTree, writeSkillTree, type SkillTree } from "./skill-files.ts";

const Pending = Schema.Struct({ before: Schema.String, after: Schema.String, ownership: Schema.String });
const ownershipDigest = (entry: ManagedSkill | undefined) => environmentDigest(JSON.stringify(entry ?? null));

function paths(path: string, targetId: string) {
  const parent = dirname(path);

  return {
    staging: join(parent, `.canopy-${targetId}-staging`),
    backup: join(parent, `.canopy-${targetId}-backup`),
    journal: join(parent, `.canopy-${targetId}-transaction.json`),
  };
}

/** Interrupted swaps recover to the old version. Unknown or subsequently edited bytes are preserved. */
export function recoverSkillSwap(path: string, targetId: string, ledger: SkillLedger): void {
  const { staging, backup, journal } = paths(path, targetId);

  if (!existsSync(journal)) return;
  const pending = Schema.decodeUnknownSync(Pending)(JSON.parse(readInstructionFile(journal).text ?? "{}"));
  const current = readSkillTree(path);
  const old = readSkillTree(backup);
  const staged = readSkillTree(staging);

  if (current.checksum === pending.after && ownershipDigest(ledger.entries.get(targetId)) === pending.ownership) {
    if (old.exists && old.checksum !== pending.before)
      throw new Error("The preserved backup was edited. Review it before syncing.");

    if (staged.exists) throw new Error("An interrupted swap has an unexpected staged directory. It was preserved.");

    if (old.exists) rmSync(backup, { recursive: true });
    rmSync(journal);

    return;
  }

  if (current.checksum === pending.after && !staged.exists && old.checksum === pending.before) {
    renameSync(path, staging);

    if (old.exists) renameSync(backup, path);
    rmSync(staging, { recursive: true });
    rmSync(journal);

    return;
  }

  if (!current.exists && old.exists && old.checksum === pending.before) renameSync(backup, path);
  else if (current.checksum !== pending.before || old.exists)
    throw new Error(
      "An interrupted skill swap contains local changes. Review its preserved staging and backup directories.",
    );

  if (staged.exists) {
    if (staged.checksum !== pending.after) throw new Error("The staged skill was edited. It was preserved for review.");
    rmSync(staging, { recursive: true });
  }

  rmSync(journal);
}

/** Stage on the same filesystem, fsync files, compare the whole directory, then publish via rename.
 * A journal covers the portable two-rename swap; a failed manifest write restores only unchanged bytes.
 */
export function swapSkillTree(
  path: string,
  current: SkillTree,
  files: readonly SkillFile[],
  ledger: SkillLedger,
  entry: ManagedSkill | undefined,
  targetId: string,
  directories: readonly string[] = current.directories,
): void {
  const { staging, backup, journal } = paths(path, targetId);

  if (existsSync(staging) || existsSync(backup) || existsSync(journal))
    throw new Error("A previous skill transaction needs recovery before syncing.");
  writeSkillTree(staging, files, directories);
  const staged = readSkillTree(staging);
  let movedOld = false;
  let published = false;
  let committed = false;

  try {
    replaceInstructionFile(
      journal,
      readInstructionFile(journal),
      JSON.stringify({ before: current.checksum, after: staged.checksum, ownership: ownershipDigest(entry) }),
    );

    if (readSkillTree(path).checksum !== current.checksum)
      throw new Error("The skill changed after the preview. Refresh before resolving.");

    if (current.exists) {
      renameSync(path, backup);
      movedOld = true;

      if (readSkillTree(backup).checksum !== current.checksum)
        throw new Error("The skill changed during the swap. Refresh before resolving.");
    }

    renameSync(staging, path);
    published = true;
    ledger.commit(targetId, entry);
    committed = true;
  } catch (error) {
    if (published) {
      if (readSkillTree(path).checksum !== staged.checksum)
        throw new Error("The skill changed during rollback. Its backup was preserved.");
      renameSync(path, staging);
    }

    if (movedOld) renameSync(backup, path);
    throw error;
  } finally {
    // A concurrent editor owns any changed bytes. Preserve them and the recovery journal.
    const stagedNow = readSkillTree(staging);
    const backupNow = readSkillTree(backup);

    if (
      (!stagedNow.exists || stagedNow.checksum === staged.checksum) &&
      (!backupNow.exists || (committed && backupNow.checksum === current.checksum))
    ) {
      if (stagedNow.exists) rmSync(staging, { recursive: true });

      if (backupNow.exists) rmSync(backup, { recursive: true });
      rmSync(journal, { force: true });
    }
  }

  if (existsSync(journal))
    throw new Error("The skill backup changed during installation. It was preserved for review.");

  if (!entry && files.length === 0 && directories.length === 0 && readSkillTree(path).files.length === 0)
    rmdirSync(path);
}
