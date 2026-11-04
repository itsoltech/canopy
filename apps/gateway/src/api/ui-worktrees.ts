import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Git worktrees (docs/worktrees.md): settings scopes and the composer's refs. */
export function worktreesHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "getWorktreeSettings" | "updateWorktreeSettings" | "listGitRefs"> {
  return {
    getWorktreeSettings: (request) => guard(() => core.getWorktreeSettings(request)),
    updateWorktreeSettings: (request) => guard(() => core.updateWorktreeSettings(request)),
    listGitRefs: (request) => guard(() => core.listGitRefs(request)),
  };
}
