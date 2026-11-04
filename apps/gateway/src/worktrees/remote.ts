import type { DescMethod, Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "../computers/remote-policy.ts";

/** Until linked gateways negotiate worktree support, never let an older home ignore the requested placement. */
export function refuseRemoteWorktree(method: DescMethod, request: Message): void {
  const worktree =
    method.name === "CreateThread" &&
    [ui.WorkspaceMode.NEW_WORKTREE, ui.WorkspaceMode.EXISTING_WORKTREE].includes(
      linkedMessage(ui.CreateThreadRequestSchema, request).workspaceMode,
    );

  if (
    worktree ||
    ["ListGitRefs", "ListWorktrees", "CleanupWorktrees", "RemoveWorktree", "RevealWorktree"].includes(method.name)
  )
    throw new ConnectError(
      "Worktrees on linked computers are not supported yet. Open Canopy on the workspace's home computer to use a worktree.",
      Code.FailedPrecondition,
    );
}
