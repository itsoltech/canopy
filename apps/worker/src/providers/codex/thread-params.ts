import type { ThreadSpec } from "@canopy/contracts";
import { realpathSync } from "node:fs";
import { codexThreadProvider } from "./launch.ts";
import { codexPermissions } from "./permissions.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";
import type { CodexThreadContext } from "./thread-types.ts";
import { threadInstructions } from "../thread-instructions.ts";
import type { CodexSandboxProfile } from "./sandbox-profile.ts";

export function codexThreadCwd(cwd: string): string {
  // On Windows Codex compares legacy and canonical writable roots. Pass the same path to both,
  // including when Windows returned an 8.3 short name for the workspace.
  return process.platform === "win32" ? realpathSync.native(cwd) : cwd;
}

/** Shared placement and permission parameters for start, resume and prefix replacement. */
export function threadParams(ctx: CodexThreadContext, spec: ThreadSpec, sandboxProfile?: CodexSandboxProfile) {
  const home = ctx.options.launch.env["CODEX_HOME"];

  if (home) managedPlugins(home, "codex");
  const profile = ctx.options.profile(spec.providerProfileId);

  if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);

  return {
    cwd: sandboxProfile?.cwd ?? codexThreadCwd(spec.cwd),
    serviceTier: spec.serviceTier || "default",
    // Scratch sessions must not discover instructions above their isolated directory.
    config: {
      ...(spec.scratch && { project_root_markers: [] }),
      ...ctx.connectorMcp?.config(spec),
      ...sandboxProfile?.config,
    },
    ...(spec.model && { model: spec.model }),
    developerInstructions: threadInstructions(spec.instructions),
    ...(sandboxProfile
      ? { approvalPolicy: "never" as const, permissions: sandboxProfile.id }
      : codexPermissions(spec.permissionMode)),
    ...codexThreadProvider(profile),
  };
}
