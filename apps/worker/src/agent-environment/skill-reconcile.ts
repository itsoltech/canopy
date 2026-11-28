import { create } from "@bufbuild/protobuf";
import {
  EnvironmentSkillStatusSchema,
  type EnvironmentResolution,
  type EnvironmentSkillStatus,
  type SkillArtifact,
  type SkillFile,
} from "@canopy/contracts";
import { skillManifestDigest, validateSkillFiles } from "@canopy/domain/skill-artifact";
import { readSkillTree } from "./skill-files.ts";
import { recoverSkillSwap, swapSkillTree } from "./skill-transaction.ts";
import type { SkillLedger, ManagedSkill } from "./skill-ledger.ts";
import type { SkillTarget } from "./skill-targets.ts";
import { isClaudeCacheMarker } from "./claude-cache.ts";
import { installedSkillDigest } from "./installed-manifest.ts";

export function reconcileSkill(
  target: SkillTarget,
  ledger: SkillLedger,
  resolution?: EnvironmentResolution,
  strict = false,
  platform: NodeJS.Platform = process.platform,
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
    if (target.problem || ledger.problem) throw new Error(target.problem || ledger.problem);
    recoverSkillSwap(target.path, target.targetId, ledger);
    const previous = ledger.entries.get(target.targetId);
    const owned = previous?.owned && previous.skillId === target.skillId;
    status.owned = Boolean(owned);
    const current = readSkillTree(target.path);
    status.observedChecksum = current.checksum;
    const managed = owned ? current.files.filter((f) => previous.files.some((p) => p.path === f.path)) : [];

    // Active Claude sessions keep per-process files in the cache liveness directory.
    const markers =
      strict && target.harness === "claude" ? current.files.filter((f) => isClaudeCacheMarker(f.path)) : [];

    const extras = current.files.filter((f) => !managed.includes(f) && !markers.includes(f));

    const changed =
      owned &&
      (installedSkillDigest(managed, platform) !==
        (platform === "win32" ? installedSkillDigest(previous.files, platform) : previous.checksum) ||
        (strict && artifact !== undefined && extras.length > 0));

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
      ledger.commit(target.targetId, {
        ...base,
        ...(previous?.localDirectories && { localDirectories: previous.localDirectories }),
        keptDesired: status.desiredChecksum,
        keptObserved: current.checksum,
      });
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

      const { directories, localDirectories } = installationDirectories(
        current.directories,
        owned ? previous : undefined,
        next,
        files,
        strict,
      );

      const entry: ManagedSkill | undefined = artifact
        ? {
            ...base,
            owned: true,
            checksum: artifact.checksum,
            files: next.map((f) => ({ path: f.path, checksum: f.checksum, executable: f.executable })),
            ...(localDirectories.length && { localDirectories }),
          }
        : // Keep plugin removal discoverable until transaction cleanup and directory retirement finish.
          strict
          ? { ...base, owned: true, checksum: skillManifestDigest([]), files: [] }
          : undefined;

      if (strict && artifact && extras.length)
        throw new Error("Move user-added plugin files before enabling it. Additional components are not approved.");

      const keepRoot = Boolean(artifact || files.length || directories.size || (strict && current.exists));

      const same =
        current.exists === keepRoot &&
        directories.size === current.directories.length &&
        installedSkillDigest(current.files, platform) === installedSkillDigest(files, platform);

      if (!same) swapSkillTree(target.path, current, files, ledger, entry, target.targetId, [...directories]);
      else ledger.commit(target.targetId, entry);
      status.status = artifact ? "applied" : "removed";
      status.owned = Boolean(artifact);
      status.observedChecksum = readSkillTree(target.path).checksum;
      status.detail = artifact
        ? "Synced. New harness sessions can use this skill."
        : "Only Canopy-installed files were removed. User-owned files were preserved.";

      return status;
    }

    describeSkillConflict(status, managed, artifact, kept);
  } catch (error) {
    status.detail = error instanceof Error ? error.message : "Couldn't reconcile this skill. Check its permissions.";
  }

  return status;
}

function describeSkillConflict(
  status: EnvironmentSkillStatus,
  managed: SkillFile[],
  artifact: SkillArtifact | undefined,
  kept: boolean,
) {
  // Only owned paths leave the worker. Unknown local skills and additional files stay private.
  status.managedFiles = managed;
  status.desiredFiles = artifact?.files ?? [];

  if (!status.owned) {
    status.detail = "This folder belongs to you. Canopy will not take it over. Rename the skill or move your folder.";

    return;
  }

  try {
    status.importable = validateSkillFiles(managed).name === artifact?.name;
  } catch {
    status.importable = false;
  }

  status.detail = kept
    ? "Local skill files are preserved until the library or folder changes."
    : "The installed skill was edited locally. Compare its owned files and choose a version.";
}

function parentDirectories(paths: readonly string[]): Set<string> {
  const directories = new Set<string>();

  for (const path of paths) {
    for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
      directories.add(path.slice(0, end));
    }
  }

  return directories;
}

function installationDirectories(
  current: readonly string[],
  previous: ManagedSkill | undefined,
  next: readonly SkillFile[],
  files: readonly SkillFile[],
  strict: boolean,
) {
  const owned = parentDirectories(previous?.files.map((file) => file.path) ?? []);

  for (const path of previous?.localDirectories ?? []) owned.delete(path);
  const local = current.filter((path) => !owned.has(path));
  const nextParents = parentDirectories(next.map((file) => file.path));
  // A version may start using a directory the user created. Keep its origin across later versions.
  const localDirectories = local.filter((path) => nextParents.has(path));
  // Active plugins also retain cache directories such as Claude's empty .in_use marker.
  const keep = strict && next.length ? current : local;
  const directories = parentDirectories(keep.map((path) => `${path}/`));
  const nextPaths = new Set(next.map((file) => file.path.toLowerCase()));

  for (const path of directories)
    if (nextPaths.has(path.toLowerCase()))
      throw new Error("A local directory blocks a file in this version. Move the directory and sync again.");

  for (const path of parentDirectories(files.map((file) => file.path))) directories.add(path);

  return { directories, localDirectories };
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
