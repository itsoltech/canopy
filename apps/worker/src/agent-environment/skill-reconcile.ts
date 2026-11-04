import { create } from "@bufbuild/protobuf";
import { EnvironmentSkillStatusSchema, type EnvironmentResolution, type SkillFile } from "@canopy/contracts";
import { skillManifestDigest, validateSkillFiles } from "@canopy/domain/skill-artifact";
import { readSkillTree } from "./skill-files.ts";
import { recoverSkillSwap, swapSkillTree } from "./skill-transaction.ts";
import type { SkillLedger, ManagedSkill } from "./skill-ledger.ts";
import type { SkillTarget } from "./skill-targets.ts";

export function reconcileSkill(
  target: SkillTarget,
  ledger: SkillLedger,
  resolution?: EnvironmentResolution,
  strict = false,
) {
  const artifact = target.desired?.artifact;

  const status = create(EnvironmentSkillStatusSchema, {
    targetId: target.targetId,
    skillId: target.skillId,
    harness: target.harness,
    path: target.path,
    scope: target.scope,
    status: "error",
    desiredChecksum: artifact?.checksum ?? "",
    version: target.desired?.version ?? 0n,
  });

  try {
    if (ledger.problem) throw new Error(ledger.problem);
    recoverSkillSwap(target.path, target.targetId, ledger);
    const current = readSkillTree(target.path);
    const previous = ledger.entries.get(target.targetId);
    status.observedChecksum = current.checksum;
    const owned = previous?.owned && previous.skillId === target.skillId;
    status.owned = Boolean(owned);
    const managed = owned ? current.files.filter((f) => previous.files.some((p) => p.path === f.path)) : [];
    // Claude creates this cache liveness marker even for read-only plugin/list commands.
    const markers = strict && target.harness === "claude" ? current.files.filter((f) => f.path === ".in_use") : [];
    const extras = current.files.filter((f) => !managed.includes(f) && !markers.includes(f));

    const changed =
      owned &&
      (skillManifestDigest(managed) !== previous.checksum || (strict && artifact !== undefined && extras.length > 0));

    const conflict = Boolean((current.exists && !owned) || changed || (owned && !current.exists && artifact));

    const force =
      resolution?.observedChecksum === current.checksum && resolution.desiredChecksum === status.desiredChecksum;

    const kept = previous?.keptDesired === status.desiredChecksum && previous.keptObserved === current.checksum;

    const base: ManagedSkill = {
      targetId: target.targetId,
      skillId: target.skillId,
      path: target.path,
      harness: target.harness,
      scope: target.scope,
      owned: Boolean(owned),
      checksum: previous?.checksum ?? "",
      files: previous?.files ?? [],
    };

    if (
      (kept && !(force && resolution?.action === "overwrite")) ||
      (conflict && force && resolution?.action === "keep")
    ) {
      ledger.commit(target.targetId, { ...base, keptDesired: status.desiredChecksum, keptObserved: current.checksum });
      status.status = "kept";
    } else if (conflict && !(force && resolution?.action === "overwrite" && owned)) {
      status.status = "drift";
    } else {
      if (!artifact && !owned) {
        ledger.commit(target.targetId, undefined);
        status.status = "removed";

        return status;
      }

      const next = artifact?.files ?? [];

      // Never replace a user-added file, including when a new version introduces the same path.
      if (conflictsWithExtras(extras, next))
        throw new Error("A new skill version conflicts with user-owned files. Move those files before syncing.");

      const files = [...next, ...extras, ...markers];

      // Preserve foreign empty directories, including Claude's empty .in_use cache marker.
      const directories =
        strict && !artifact && owned
          ? current.directories.filter(
              (dir) =>
                !previous.files.some((file) => file.path.startsWith(`${dir}/`)) ||
                extras.some((file) => file.path.startsWith(`${dir}/`)),
            )
          : current.directories;

      const entry: ManagedSkill | undefined = artifact
        ? {
            ...base,
            owned: true,
            checksum: artifact.checksum,
            files: next.map((f) => ({ path: f.path, checksum: f.checksum, executable: f.executable })),
          }
        : strict && (files.length || directories.length)
          ? { ...base, owned: true, checksum: skillManifestDigest([]), files: [] }
          : undefined;

      if (strict && artifact && extras.length)
        throw new Error("Move user-added plugin files before enabling it. Additional components are not approved.");
      const same = current.exists && skillManifestDigest(current.files) === skillManifestDigest(files);

      if (!same && (artifact || current.exists))
        swapSkillTree(target.path, current, files, ledger, entry, target.targetId, directories);
      else ledger.commit(target.targetId, entry);
      status.status = artifact ? "applied" : "removed";
      status.owned = Boolean(artifact);
      status.observedChecksum = readSkillTree(target.path).checksum;
      status.detail = artifact
        ? "Synced. New harness sessions can use this skill."
        : "Only Canopy-installed files were removed. User-owned files were preserved.";

      return status;
    }

    // Only owned paths leave the worker. Unknown local skills and additional files stay private.
    status.managedFiles = managed;
    status.desiredFiles = artifact?.files ?? [];

    if (owned) {
      try {
        status.importable = validateSkillFiles(managed).name === artifact?.name;
      } catch {
        status.importable = false;
      }
    }

    status.detail = !owned
      ? "This folder belongs to you. Canopy will not take it over. Rename the skill or move your folder."
      : kept
        ? "Local skill files are preserved until the library or folder changes."
        : "The installed skill was edited locally. Compare its owned files and choose a version.";
  } catch (error) {
    status.detail = error instanceof Error ? error.message : "Couldn't reconcile this skill. Check its permissions.";
  }

  return status;
}

function conflictsWithExtras(extras: readonly SkillFile[], next: readonly SkillFile[]): boolean {
  return extras.some((file) =>
    next.some((candidate) => {
      const local = file.path.toLowerCase();
      const desired = candidate.path.toLowerCase();

      return desired === local || desired.startsWith(`${local}/`) || local.startsWith(`${desired}/`);
    }),
  );
}
