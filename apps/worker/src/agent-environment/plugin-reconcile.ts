import { create } from "@bufbuild/protobuf";
import { rmdirSync } from "node:fs";
import { EnvironmentSkillStatusSchema, type EnvironmentResolution } from "@canopy/contracts";
import { assertCodexPluginSlot } from "./codex-plugin-cache.ts";
import { recoverSkillSwap } from "./skill-transaction.ts";
import { reconcileSkill } from "./skill-reconcile.ts";
import type { SkillTarget } from "./skill-targets.ts";
import type { SkillLedger } from "./skill-ledger.ts";
import { readSkillTree } from "./skill-files.ts";

export function reconcilePlugin(
  target: SkillTarget,
  ledger: SkillLedger,
  resolution: EnvironmentResolution | undefined,
  platform: NodeJS.Platform,
) {
  try {
    if (target.problem) throw new Error(target.problem);

    if (target.harness === "codex" && target.desired) {
      recoverSkillSwap(target.path, target.targetId, ledger);
      assertCodexPluginSlot(target.path);
    }

    const status = reconcileSkill(target, ledger, resolution, true, platform);
    status.importable = false;

    if (status.status === "applied") status.detail = "Reviewed plugin synced. Start a new harness session to load it.";

    if (status.status === "removed" && ledger.entries.get(target.targetId)?.owned) {
      const tree = readSkillTree(target.path);

      if (!tree.files.length && !tree.directories.length) {
        if (tree.exists) rmdirSync(target.path);
        ledger.commit(target.targetId, undefined);
      }
    }

    return status;
  } catch (error) {
    return create(EnvironmentSkillStatusSchema, {
      targetId: target.targetId,
      skillId: target.skillId,
      harness: target.harness,
      scope: target.scope,
      path: target.path,
      status: "error",
      desiredChecksum: target.desired?.artifact?.checksum ?? "",
      version: target.desired?.version ?? 0n,
      detail: error instanceof Error ? error.message : "Couldn't sync this plugin. Refresh its environment.",
    });
  }
}
