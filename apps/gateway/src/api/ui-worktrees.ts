import { type GatewayCore } from "../core/core.ts";
import { guard, toConnectError } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";
import { WorkspaceBranches } from "../worktrees/workspace-branches.ts";
import { ThreadBranches } from "../worktrees/thread-branches.ts";
import { ThreadFiles } from "../files/thread-files.ts";
import { ThreadDiff } from "../files/thread-diff.ts";
import { ThreadDirectory } from "../files/thread-directory.ts";
import { ThreadHighlight } from "../files/thread-highlight.ts";
import { ThreadWatch } from "../files/thread-watch.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { serviceIdentity } from "./auth.ts";

/** Git worktrees (docs/worktrees.md): settings scopes and the composer's refs; a thread's folder and files. */
export function worktreesHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getWorktreeSettings"
  | "updateWorktreeSettings"
  | "listGitRefs"
  | "listWorkspaceBranches"
  | "switchWorkspaceBranch"
  | "listThreadBranches"
  | "switchThreadBranch"
  | "getThreadGitStatus"
  | "pullThreadOrigin"
  | "listWorktrees"
  | "cleanupWorktrees"
  | "removeWorktree"
  | "revealWorktree"
  | "revealThreadDirectory"
  | "readThreadFile"
  | "listThreadDirectory"
  | "listThreadDiff"
  | "readThreadDiff"
  | "getThreadFileHighlight"
  | "watchThreadFiles"
  | "writeThreadFile"
  | "deleteThreadFile"
  | "openThreadFile"
  | "revealThreadFile"
> {
  const branches = new ThreadBranches(core);
  const workspaceBranches = new WorkspaceBranches(core);
  const files = new ThreadFiles(core);
  const directory = new ThreadDirectory(core);
  const diff = new ThreadDiff(core);
  const highlight = new ThreadHighlight(core);
  const watch = new ThreadWatch(core);

  return {
    listWorkspaceBranches: (request) => guard(() => workspaceBranches.list(request)),
    switchWorkspaceBranch: (request) => guard(() => workspaceBranches.switch(request)),
    listThreadBranches: (request) => guard(() => branches.list(request)),
    getThreadGitStatus: (request) => guard(() => branches.status(request)),
    pullThreadOrigin: (request) => guard(() => branches.pull(request)),
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
    listThreadDiff: (request) => guard(() => diff.list(request)),
    readThreadDiff: (request) => guard(() => diff.read(request)),
    listThreadDirectory: (request) => guard(() => directory.list(request)),
    getThreadFileHighlight: (request) => guard(() => highlight.read(request)),
    watchThreadFiles: async function* (request, context) {
      try {
        yield* watch.watch(request, context.signal);
      } catch (cause) {
        throw toConnectError(cause);
      }
    },
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
    revealThreadFile: (request, context) =>
      guard(async () => {
        if (core.role !== "desktop" || !context.values.get(serviceIdentity))
          throw new ConnectError("Reveal files from the Canopy app on this computer.", Code.PermissionDenied);
        await files.reveal(request);

        return {};
      }),
  };
}
