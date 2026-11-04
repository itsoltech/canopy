import { join } from "node:path";
import type { AgentEnvironmentDesired, EnvironmentInstruction } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { providersOf } from "../providers/profiles.ts";
import type { InstructionLedger } from "./ledger.ts";

export interface InstructionTarget {
  readonly targetId: string;
  readonly path: string;
  readonly harness: "claude" | "codex";
  readonly scope: "device" | "platform";
  readonly content: string;
}

export interface EnvironmentHomes {
  readonly dataDir: string;
  readonly deviceHomes: { readonly claude: string; readonly codex: string };
  readonly config: AppliedConfig | undefined;
}

/** Uses the same instanceShadowHome resolver as the actual Claude and Codex runtime launchers. */
export function instructionTargets(
  desired: AgentEnvironmentDesired,
  homes: EnvironmentHomes,
  ledger: InstructionLedger,
): InstructionTarget[] {
  const targets = new Map<string, InstructionTarget>();

  for (const harness of ["claude", "codex"] as const) {
    const device = desired.instructions.find((i) => i.harness === harness && i.deviceHome);
    const platform = desired.instructions.find((i) => i.harness === harness && i.platformHome);
    const filename = harness === "claude" ? "CLAUDE.md" : "AGENTS.md";

    const add = (home: string, scope: "device" | "platform", instruction: EnvironmentInstruction | undefined) => {
      if (!instruction?.content) return;
      const path = join(home, filename);
      const targetId = environmentDigest(path);
      const existing = targets.get(targetId);

      if (existing && existing.content !== instruction.content)
        throw new Error(
          "Device and platform instructions share a home but have different content. Choose separate homes.",
        );
      targets.set(targetId, { targetId, path, harness, scope, content: instruction.content });
    };

    add(homes.deviceHomes[harness], "device", device);
    add(join(homes.dataDir, `${harness}-home`), "platform", platform);

    for (const profile of homes.config?.profiles ?? []) {
      if (!providersOf(profile.config).includes(harness)) continue;
      const home = instanceShadowHome(homes.dataDir, harness, profile.config.id, profile.config.runtime);

      if (home) add(home, "platform", platform);
    }
  }

  // Removed assignments and old shadow homes: remove only our own unchanged managed block.
  for (const entry of ledger.entries.values())
    if (!targets.has(entry.targetId)) targets.set(entry.targetId, { ...entry, content: "" });

  if (targets.size > 128)
    throw new Error("This worker has more than 128 instruction destinations. Reduce the number of instance homes.");

  return [...targets.values()];
}
