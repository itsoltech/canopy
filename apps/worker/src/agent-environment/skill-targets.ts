import { dirname, join, resolve } from "node:path";
import type { AgentEnvironmentDesired, EnvironmentSkill } from "@canopy/contracts";
import { isHarness } from "@canopy/domain/harnesses";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { instanceShadowHome } from "../config/remote.ts";
import { providerConfigurationPath } from "../providers/claude/configuration-homes.ts";
import { antigravityHomeProblem, canonicalHome, pathsOverlap } from "../providers/home-paths.ts";
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
  readonly privateHome?: string;
}

export const platformSkillRoot = (home: string, harness: string): string =>
  harness === "claude" ? join(home, "canopy-environment", "skills") : join(home, "skills");

export function deviceSkillRoots(homes: Pick<EnvironmentHomes, "deviceHomes">) {
  const { claude, codex, grok, antigravity, agents } = homes.deviceHomes;
  const parent = dirname(codex);

  return {
    claude: join(claude, "skills"),
    codex: agents ?? join(parent, ".agents", "skills"),
    grok: join(grok ?? join(parent, ".grok"), "skills"),
    antigravity: join(antigravity ?? join(parent, ".gemini", "antigravity-cli"), "skills"),
  };
}

export function deviceSkillInventoryRoots(homes: Pick<EnvironmentHomes, "deviceHomes">): ReadonlyMap<string, string> {
  const roots = new Map(Object.entries(deviceSkillRoots(homes)).map(([harness, root]) => [root, harness]));
  roots.set(join(homes.deviceHomes.codex, "skills"), "codex");

  return roots;
}

/** Only generated private homes are eligible. An explicit shadow, CLI login or configuration source
 * can belong to another application, even when it aliases a generated path. */
export function platformSkillArchiveHomes(
  homes: EnvironmentHomes,
  targets: readonly SkillTarget[],
  ledger: SkillLedger,
) {
  const candidates = new Set<string>();

  for (const target of targets) {
    if (target.privateHome && !ledger.entries.get(target.targetId)?.owned) candidates.add(target.privateHome);
  }

  if (!candidates.size) return candidates;
  const deviceRoots = [...deviceSkillInventoryRoots(homes).keys()];
  const protectedPaths = new Set([...deviceRoots, ...deviceRoots.map(dirname)]);

  try {
    for (const { config } of homes.config?.profiles ?? []) {
      const runtime = config.runtime;

      for (const path of [runtime?.homePath, runtime?.shadowHomePath, runtime?.userConfiguration?.sourcePath]) {
        if (!path) continue;
        const home = providerConfigurationPath(path);
        protectedPaths.add(home);
        protectedPaths.add(join(home, "skills"));
        protectedPaths.add(platformSkillRoot(home, "claude"));
      }
    }

    // A symlink from a second provider's skills root also makes its destination shared.
    for (const root of new Set(targets.map((target) => dirname(target.path)))) {
      if (canonicalHome(root) !== resolve(root)) protectedPaths.add(root);
    }

    const normalized = (path: string) => canonicalHome(path).normalize("NFC").toLowerCase();
    const protectedRoots = [...protectedPaths].map(normalized);

    for (const home of candidates) {
      const privateRoot = normalized(home);

      if (protectedRoots.some((root) => pathsOverlap(privateRoot, root))) candidates.delete(home);
    }
  } catch {
    return new Set<string>();
  }

  return candidates;
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

    const add = (root: string, harness: string, scope: string, privateHome?: string) => {
      const path = join(root, name);
      const targetId = environmentDigest(`skill:${path}`);
      const previous = targets.get(targetId);

      if (previous && previous.skillId !== skill.id)
        throw new Error("Two skills use the same destination. Review their assignments.");

      if (harness === "antigravity" && scope === "platform" && previous?.scope === "device") return;
      targets.set(targetId, {
        targetId,
        skillId: skill.id,
        path,
        harness,
        scope,
        desired: skill,
        ...(privateHome && { privateHome }),
      });
    };

    for (const harness of skill.harnesses) {
      if (!isHarness(harness)) throw new Error("Unsupported skill harness.");

      if (skill.deviceHome) add(deviceRoots[harness], harness, "device");

      if (!skill.platformHome) continue;
      const home = join(homes.dataDir, `${harness}-home`);
      add(platformSkillRoot(home, harness), harness, "platform", home);

      for (const profile of homes.config?.profiles ?? []) {
        if (!providersOf(profile.config).includes(harness)) continue;
        const shadow = instanceShadowHome(homes.dataDir, harness, profile.config.id, profile.config.runtime);

        if (shadow)
          add(
            platformSkillRoot(shadow, harness),
            harness,
            "platform",
            profile.config.runtime?.shadowHomePath ? undefined : shadow,
          );
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
