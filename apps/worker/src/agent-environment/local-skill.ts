import { create } from "@bufbuild/protobuf";
import { basename, sep } from "node:path";
import { EnvironmentSkillStatusSchema, type EnvironmentResolution } from "@canopy/contracts";
import { archiveSkillCopy, inspectSkillCopy, type InventoryBudget } from "./skill-archive.ts";
import type { SkillDirectory } from "./skill-directory.ts";
import type { SkillTarget } from "./skill-targets.ts";
import { readSkillTree } from "./skill-files.ts";
import type { SkillLedger } from "./skill-ledger.ts";

export function copyStatus(target: SkillTarget) {
  return create(EnvironmentSkillStatusSchema, {
    targetId: target.targetId,
    harness: target.harness,
    path: target.path,
    scope: target.scope,
    localName: basename(target.path),
    skillId: target.skillId,
    version: target.desired?.version ?? 0n,
    desiredChecksum: target.desired?.artifact?.checksum ?? "",
    status: "error",
  });
}

function overlapsOwned(target: SkillTarget, ledger: SkillLedger): boolean {
  const normal = (path: string) => path.normalize("NFC").toLowerCase() + sep;
  const path = normal(target.path);

  return [...ledger.entries.values()].some((entry) => {
    const installed = normal(entry.path);

    return entry.owned && (installed.startsWith(path) || path.startsWith(installed));
  });
}

function keptCopy(target: SkillTarget, ledger: SkillLedger, token: string, keep: boolean): boolean {
  const previous = ledger.entries.get(target.targetId);
  const checksum = target.desired?.artifact?.checksum;

  if (!checksum) return false;
  const marker = `device:${token}`;

  if (previous?.keptDesired === checksum) {
    if (previous.keptObserved === marker) return true;

    // Earlier workers recorded a content digest for a user's explicit keep decision.
    // Migrate it once while reconciling the same assignment; no comparison files are reported.
    if (!keep && previous.keptObserved && !previous.keptObserved.startsWith("device:")) {
      try {
        keep = readSkillTree(target.path).checksum === previous.keptObserved;
      } catch {
        keep = false;
      }

      if (!keep) ledger.commit(target.targetId, undefined);
    }
  }

  if (keep)
    ledger.commit(target.targetId, {
      targetId: target.targetId,
      skillId: target.skillId,
      path: target.path,
      scope: target.scope,
      harness: target.harness,
      owned: false,
      checksum: "",
      files: [],
      keptDesired: checksum,
      keptObserved: marker,
    });

  return keep;
}

export function localCopy(
  target: SkillTarget,
  ledger: SkillLedger,
  resolution: EnvironmentResolution | undefined,
  home: SkillDirectory,
  root: SkillDirectory,
  budget: InventoryBudget,
) {
  const status = copyStatus(target);
  const name = status.localName;
  const discovered = !target.skillId;

  try {
    const entry = root.entry(name);

    if (!entry) return;
    status.localLink = entry.kind === "link";

    if (entry.kind !== "link" && entry.kind !== "directory") {
      if (discovered && resolution?.action !== "archive") return;
      throw new Error("A file occupies the skill destination. Move it to another folder before syncing.");
    }

    if (discovered && entry.kind === "directory") {
      const dir = root.child(name);

      try {
        if (!dir.entry("SKILL.md")) {
          if (resolution?.action === "archive") throw new Error("The skill entry changed. Review its current folder.");

          return;
        }
      } finally {
        dir.close();
      }
    }

    if (discovered) status.status = "local";

    if (ledger.problem) throw new Error(ledger.problem);

    if (overlapsOwned(target, ledger)) throw new Error("This folder overlaps a Canopy installation.");

    if (["transaction.json", "staging", "backup"].some((suffix) => root.entry(`.canopy-${target.targetId}-${suffix}`)))
      throw new Error("An interrupted installation needs recovery before this copy can be moved.");

    const { token } = inspectSkillCopy(root, name, target.targetId, budget);
    status.archiveToken = token;
    status.observedChecksum = token;
    const current = resolution?.observedChecksum === token && resolution.desiredChecksum === status.desiredChecksum;

    if (resolution?.action === "archive") {
      if (!current) throw new Error("The copy or its assignment changed. Refresh the list and review it again.");
      archiveSkillCopy(home, root, name, target.targetId, token);
      ledger.commit(target.targetId, undefined);

      return;
    }

    if (discovered) return status;

    if (keptCopy(target, ledger, token, Boolean(current && resolution?.action === "keep"))) {
      status.status = "kept";
      status.detail = "This computer is keeping its local copy.";
    } else {
      status.status = entry.kind === "link" ? "error" : "drift";
      status.detail =
        entry.kind === "link"
          ? "A local link occupies the installation path. Removing this copy moves only the link."
          : "A local folder occupies the installation path. Move it aside to install the library version.";
    }
  } catch (error) {
    if (resolution?.action === "archive") status.status = "error";
    status.detail = error instanceof Error ? error.message : "Couldn't inspect this copy.";
  }

  return status;
}
