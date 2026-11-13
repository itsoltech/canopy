import type { ThreadSpec } from "@canopy/contracts";
import { codexThreadProvider } from "./launch.ts";
import { codexPermissions } from "./permissions.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";
import type { CodexThreadContext } from "./thread-types.ts";

/** Shared placement and permission parameters for start, resume and prefix replacement. */
export function threadParams(ctx: CodexThreadContext, spec: ThreadSpec) {
  const home = ctx.options.launch.env["CODEX_HOME"];

  if (home) managedPlugins(home, "codex");
  ctx.connectorCatalog.set(spec.threadId, spec.connectorTools);
  const profile = ctx.options.profile(spec.providerProfileId);

  if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);

  return {
    cwd: spec.cwd,
    // Scratch sessions must not discover instructions above their isolated directory.
    config: {
      ...(spec.scratch && { project_root_markers: [] }),
      ...ctx.connectorMcp?.config(spec),
    },
    ...(spec.model && { model: spec.model }),
    ...(spec.instructions && { developerInstructions: spec.instructions }),
    ...codexPermissions(spec.permissionMode),
    ...codexThreadProvider(profile),
  };
}
