import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Git worktrees (docs/worktrees.md): settings scopes and the composer's refs. */
export function worktreesHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getWorktreeSettings"
  | "updateWorktreeSettings"
  | "listGitRefs"
  | "listWorktrees"
  | "cleanupWorktrees"
  | "removeWorktree"
  | "revealWorktree"
> {
  return {
    getWorktreeSettings: (request) => guard(() => core.getWorktreeSettings(request)),
    updateWorktreeSettings: (request) => guard(() => core.updateWorktreeSettings(request)),
    listGitRefs: (request) => guard(() => core.listGitRefs(request)),
    listWorktrees: (request) => guard(() => core.listWorktrees(request)),
    cleanupWorktrees: (request) => guard(() => core.cleanupWorktrees(request)),
    removeWorktree: (request) => guard(() => core.removeWorktree(request)),
    revealWorktree: (request) =>
      guard(async () => {
        await core.revealWorktree(request);

        return {};
      }),
  };
}
