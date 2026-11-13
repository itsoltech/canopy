import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";
import { ThreadBranches } from "../worktrees/thread-branches.ts";
import { ThreadFiles } from "../files/thread-files.ts";
import { ThreadDirectory } from "../files/thread-directory.ts";

/** Git worktrees (docs/worktrees.md): settings scopes and the composer's refs; a thread's folder and files. */
export function worktreesHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getWorktreeSettings"
  | "updateWorktreeSettings"
  | "listGitRefs"
  | "listThreadBranches"
  | "switchThreadBranch"
  | "listWorktrees"
  | "cleanupWorktrees"
  | "removeWorktree"
  | "revealWorktree"
  | "revealThreadDirectory"
  | "readThreadFile"
  | "listThreadDirectory"
  | "writeThreadFile"
  | "deleteThreadFile"
  | "openThreadFile"
> {
  const branches = new ThreadBranches(core);
  const files = new ThreadFiles(core);
  const directory = new ThreadDirectory(core);

  return {
    listThreadBranches: (request) => guard(() => branches.list(request)),
    switchThreadBranch: (request) => guard(() => branches.switch(request)),
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
    revealThreadDirectory: (request) =>
      guard(async () => {
        await branches.reveal(request);

        return {};
      }),
    readThreadFile: (request) => guard(() => files.read(request)),
    listThreadDirectory: (request) => guard(() => directory.list(request)),
    writeThreadFile: (request) => guard(() => files.write(request)),
    deleteThreadFile: (request) =>
      guard(async () => {
        await files.delete(request);

        return {};
      }),
    openThreadFile: (request) =>
      guard(async () => {
        await files.open(request);

        return {};
      }),
  };
}
