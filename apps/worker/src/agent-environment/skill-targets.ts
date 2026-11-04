import { dirname, join } from "node:path";
import type { AgentEnvironmentDesired, EnvironmentSkill } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { instanceShadowHome } from "../config/remote.ts";
import { providersOf } from "../providers/profiles.ts";
import type { EnvironmentHomes } from "./targets.ts";
import type { SkillLedger } from "./skill-ledger.ts";

export interface SkillTarget {
  readonly targetId: string;
  readonly skillId: string;
  readonly path: string;
  readonly harness: string;
  readonly scope: string;
  readonly desired?: EnvironmentSkill;
}

export const platformSkillRoot = (home: string, harness: string): string =>
  harness === "claude" ? join(home, "canopy-environment", "skills") : join(home, "skills");

export function skillTargets(
  desired: AgentEnvironmentDesired,
  homes: EnvironmentHomes,
  ledger: SkillLedger,
): SkillTarget[] {
  const targets = new Map<string, SkillTarget>();

  for (const skill of desired.skills) {
    if (!skill.artifact) throw new Error("Missing skill artifact.");
    const name = skill.artifact.name;

    const add = (root: string, harness: string, scope: string) => {
      const path = join(root, name);
      const targetId = environmentDigest(`skill:${path}`);
      const previous = targets.get(targetId);

      if (previous && previous.skillId !== skill.id)
        throw new Error("Two skills use the same destination. Review their assignments.");
      targets.set(targetId, { targetId, skillId: skill.id, path, harness, scope, desired: skill });
    };

    for (const harness of skill.harnesses) {
      if (harness !== "claude" && harness !== "codex" && harness !== "grok")
        throw new Error("Unsupported skill harness.");

      if (skill.deviceHome) {
        const root =
          harness === "codex"
            ? (homes.deviceHomes.agents ?? join(dirname(homes.deviceHomes.codex), ".agents", "skills"))
            : join(
                harness === "grok"
                  ? (homes.deviceHomes.grok ?? join(dirname(homes.deviceHomes.codex), ".grok"))
                  : homes.deviceHomes.claude,
                "skills",
              );

        add(root, harness, "device");
      }

      if (!skill.platformHome) continue;
      add(platformSkillRoot(join(homes.dataDir, `${harness}-home`), harness), harness, "platform");

      for (const profile of homes.config?.profiles ?? []) {
        if (!providersOf(profile.config).includes(harness)) continue;
        const home = instanceShadowHome(homes.dataDir, harness, profile.config.id, profile.config.runtime);

        if (home) add(platformSkillRoot(home, harness), harness, "platform");
      }
    }
  }

  for (const entry of ledger.entries.values())
    if (!targets.has(entry.targetId)) targets.set(entry.targetId, { ...entry });

  if (targets.size > 512) throw new Error("This worker has more than 512 skill destinations.");

  return [...targets.values()];
}
