import { dirname, join } from "node:path";
import type { AgentEnvironmentDesired, EnvironmentSkill } from "@canopy/contracts";
import { isHarness } from "@canopy/domain/harnesses";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { instanceShadowHome } from "../config/remote.ts";
import { antigravityHomeProblem } from "../providers/home-paths.ts";
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
  readonly problem?: string;
}

export const platformSkillRoot = (home: string, harness: string): string =>
  harness === "claude" ? join(home, "canopy-environment", "skills") : join(home, "skills");

export function deviceSkillRoots(homes: EnvironmentHomes) {
  const { claude, codex, grok, antigravity, agents } = homes.deviceHomes;
  const parent = dirname(codex);

  return {
    claude: join(claude, "skills"),
    codex: agents ?? join(parent, ".agents", "skills"),
    grok: join(grok ?? join(parent, ".grok"), "skills"),
    antigravity: join(antigravity ?? join(parent, ".gemini", "antigravity-cli"), "skills"),
  };
}

export function skillTargets(
  desired: AgentEnvironmentDesired,
  homes: EnvironmentHomes,
  ledger: SkillLedger,
): SkillTarget[] {
  const targets = new Map<string, SkillTarget>();
  const deviceRoots = deviceSkillRoots(homes);

  for (const skill of desired.skills) {
    if (!skill.artifact) throw new Error("Missing skill artifact.");
    const name = skill.artifact.name;

    const add = (root: string, harness: string, scope: string) => {
      const path = join(root, name);
      const targetId = environmentDigest(`skill:${path}`);
      const previous = targets.get(targetId);

      if (previous && previous.skillId !== skill.id)
        throw new Error("Two skills use the same destination. Review their assignments.");

      if (harness === "antigravity" && scope === "platform" && previous?.scope === "device") return;
      targets.set(targetId, { targetId, skillId: skill.id, path, harness, scope, desired: skill });
    };

    for (const harness of skill.harnesses) {
      if (!isHarness(harness)) throw new Error("Unsupported skill harness.");

      if (skill.deviceHome) add(deviceRoots[harness], harness, "device");

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

  // A previously valid destination can now overlap the device home, even during removal.
  return [...targets.values()].map((target) => {
    if (target.harness !== "antigravity" || target.scope !== "platform") return target;
    const problem = antigravityHomeProblem(dirname(dirname(target.path)), dirname(deviceRoots.antigravity));

    return problem ? { ...target, problem } : target;
  });
}
