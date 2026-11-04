import { join, resolve } from "node:path";
import type { AgentEnvironmentDesired } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { instanceShadowHome } from "../config/remote.ts";
import { providersOf } from "../providers/profiles.ts";
import type { EnvironmentHomes } from "./targets.ts";
import type { SkillLedger } from "./skill-ledger.ts";
import type { SkillTarget } from "./skill-targets.ts";

export const pluginHome = (path: string) => resolve(path, "../../../../..");
export const pluginNamespace = (id: string, harness: string) => `canopy-${id}-${harness}`;

export function pluginTargets(desired: AgentEnvironmentDesired, homes: EnvironmentHomes, ledger: SkillLedger) {
  const targets = new Map<string, SkillTarget>();

  for (const plugin of desired.plugins) {
    for (const harness of plugin.harnesses) {
      if (harness !== "claude" && harness !== "codex") throw new Error("Unsupported plugin harness.");

      const add = (home: string, scope: string) => {
        const path = join(home, "plugins/cache", pluginNamespace(plugin.id, harness), plugin.artifact!.name, "local");
        const targetId = environmentDigest(`skill:${path}`);
        targets.set(targetId, { targetId, path, skillId: plugin.id, harness, scope, desired: plugin });
      };

      if (plugin.deviceHome) add(homes.deviceHomes[harness], "device");

      if (!plugin.platformHome) continue;
      add(join(homes.dataDir, `${harness}-home`), "platform");

      for (const profile of homes.config?.profiles ?? []) {
        if (!providersOf(profile.config).includes(harness)) continue;
        const home = instanceShadowHome(homes.dataDir, harness, profile.config.id, profile.config.runtime);

        if (home) add(home, "platform");
      }
    }
  }

  for (const entry of ledger.entries.values()) if (!targets.has(entry.targetId)) targets.set(entry.targetId, entry);

  if (targets.size > 384) throw new Error("This worker has more than 384 plugin destinations.");

  return [...targets.values()];
}
