import { basename, dirname, join } from "node:path";
import type { AgentEnvironmentDesired, EnvironmentResolution, EnvironmentSkillStatus } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { copyStatus, localCopy } from "./local-skill.ts";
import type { InventoryBudget } from "./skill-archive.ts";
import { withSkillDirectory, type SkillDirectory } from "./skill-directory.ts";
import { deviceSkillRoots, skillTargets, type SkillTarget } from "./skill-targets.ts";
import { reconcileSkill } from "./skill-reconcile.ts";
import type { EnvironmentHomes } from "./targets.ts";
import type { SkillLedger } from "./skill-ledger.ts";

const journalName = (target: SkillTarget) => `.canopy-${target.targetId}-transaction.json`;

function withSkillRoot<T>(path: string, run: (home: SkillDirectory, root: SkillDirectory) => T) {
  return withSkillDirectory(dirname(path), (home) => {
    const name = basename(path);

    if (!home.entry(name)) return;
    const root = home.child(name);

    try {
      return run(home, root);
    } finally {
      root.close();
    }
  });
}

function reconcileTarget(
  target: SkillTarget,
  ledger: SkillLedger,
  roots: ReadonlyMap<string, string>,
  action: EnvironmentResolution | undefined,
  budget: InventoryBudget,
) {
  const rootPath = dirname(target.path);
  const owned = ledger.entries.get(target.targetId)?.owned;

  if (!owned && target.scope === "device" && (roots.has(rootPath) || !target.desired)) {
    try {
      if (!target.desired && !ledger.problem) {
        const pending = withSkillRoot(rootPath, (_home, root) => root.entry(journalName(target)));

        if (!pending) {
          ledger.commit(target.targetId, undefined);

          return;
        }
      } else {
        const status = withSkillRoot(rootPath, (home, root) => {
          // A pending swap may have installed a library copy before committing its ownership.
          if (root.entry(journalName(target))) return;

          return localCopy(target, ledger, action, home, root, budget);
        });

        if (status) return status;
      }
    } catch {
      const failure = copyStatus(target);
      failure.detail =
        "Couldn't access this skill destination. Check its permissions and parent directories for symlinks.";

      return failure;
    }
  }

  const status = reconcileSkill(target, ledger, action);

  if (target.scope === "device") status.localName = basename(target.path);

  return status;
}

export function inventorySkills(
  desired: AgentEnvironmentDesired,
  homes: EnvironmentHomes,
  ledger: SkillLedger,
  previousLocal: readonly EnvironmentSkillStatus[] = [],
) {
  const targets = skillTargets(desired, homes, ledger);
  const roots = new Map<string, string>();

  for (const [harness, root] of Object.entries(deviceSkillRoots(homes))) roots.set(root, harness);
  roots.set(join(homes.deviceHomes.codex, "skills"), "codex");
  const budget = { remaining: 8192 };
  const actions = new Map(desired.skillResolutions.map((action) => [action.targetId, action]));
  const skills: EnvironmentSkillStatus[] = [];
  let scanned = true;

  for (const target of targets) {
    const status = reconcileTarget(target, ledger, roots, actions.get(target.targetId), budget);

    if (status) skills.push(status);
  }

  const byPath = new Set(skills.map((status) => status.path));

  // Resolve a previewed local entry before unrelated discovered entries can fill the report, including when its root cannot be listed.
  // Only re-open names produced by this worker in its current CLI roots.
  for (const previous of previousLocal) {
    const action = actions.get(previous.targetId);

    if (action?.action !== "archive" || byPath.has(previous.path) || skills.length >= 512) continue;
    const rootPath = dirname(previous.path);

    const target = {
      targetId: previous.targetId,
      skillId: "",
      path: previous.path,
      harness: previous.harness,
      scope: "device",
    };

    try {
      if (!roots.has(rootPath)) throw new Error();
      const status = withSkillRoot(rootPath, (home, root) => localCopy(target, ledger, action, home, root, budget));

      if (status) {
        skills.push(status);
        byPath.add(previous.path);
      }
    } catch {
      const failure = copyStatus(target);
      failure.detail =
        "Couldn't move this copy. Check that its original CLI directory is available and contains no parent links.";
      skills.push(failure);
      byPath.add(previous.path);
    }

    actions.delete(previous.targetId);
  }

  for (const [path, harness] of roots) {
    try {
      withSkillRoot(path, (home, root) => {
        const knownEntries = new Set<string>();

        for (const target of byPath) {
          if (dirname(target) !== path) continue;
          const entry = root.entry(basename(target));

          if (entry) knownEntries.add(entry.identity);
        }

        for (const localName of root.names(2048)) {
          const copy = join(path, localName);

          if (localName.startsWith(".") || byPath.has(copy)) continue;
          // Case-insensitive volumes can return the assigned path under another spelling.
          const entry = root.entry(localName);

          if (!entry || knownEntries.has(entry.identity)) continue;

          if (skills.length >= 512) {
            scanned = false;
            break;
          }

          const targetId = environmentDigest(`skill:${copy}`);
          const target = { targetId, path: copy, skillId: "", harness, scope: "device" };
          const status = localCopy(target, ledger, actions.get(targetId), home, root, budget);

          if (status) skills.push(status);
        }
      });
    } catch {
      scanned = false;
    }
  }

  return { skills, scanned };
}
