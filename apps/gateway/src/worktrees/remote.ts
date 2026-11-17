import type { DescMethod, Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Match } from "effect";
import { linkedMessage } from "../computers/remote-policy.ts";
import {
  REMOTE_BRANCH_SWITCH,
  REMOTE_BRANCH_STASH,
  REMOTE_WORKSPACE_BRANCH_SWITCH,
  REMOTE_GIT_STATUS,
} from "@canopy/domain/computers";

export function refuseRemoteBranchSwitch(method: DescMethod, capabilities: readonly string[], request: Message): void {
  if (["GetThreadGitStatus", "PullThreadOrigin"].includes(method.name) && !capabilities.includes(REMOTE_GIT_STATUS))
    throw new ConnectError(
      "Update the thread's home computer to read changes and pull from origin.",
      Code.FailedPrecondition,
    );

  if (
    ["ListWorkspaceBranches", "SwitchWorkspaceBranch"].includes(method.name) &&
    !capabilities.includes(REMOTE_WORKSPACE_BRANCH_SWITCH)
  )
    throw new ConnectError("Update the workspace's home computer to switch branches.", Code.FailedPrecondition);

  const stash = Match.value(method.name).pipe(
    Match.when("SwitchThreadBranch", () => linkedMessage(ui.SwitchThreadBranchRequestSchema, request).stashChanges),
    Match.when(
      "SwitchWorkspaceBranch",
      () => linkedMessage(ui.SwitchWorkspaceBranchRequestSchema, request).stashChanges,
    ),
    Match.orElse(() => false),
  );

  if (stash && !capabilities.includes(REMOTE_BRANCH_STASH))
    throw new ConnectError(
      "Update the home computer to stash changes when switching branches.",
      Code.FailedPrecondition,
    );

  if (
    ["ListThreadBranches", "SwitchThreadBranch"].includes(method.name) &&
    !capabilities.includes(REMOTE_BRANCH_SWITCH)
  )
    throw new ConnectError("Update the thread's home computer to switch branches.", Code.FailedPrecondition);
}

export function refuseRemoteAutomation(mode: string | undefined, fork = false): void {
  if (mode && mode !== "checkout")
    throw new ConnectError(
      "Worktrees on linked computers are not supported yet. Open Canopy on the workspace's home computer to use a worktree.",
      Code.FailedPrecondition,
    );

  if (fork)
    throw new ConnectError("Fork is unavailable across computers; send context in prompt", Code.FailedPrecondition);
}

/** Until linked gateways negotiate worktree support, never let an older home ignore the requested placement. */
export function refuseRemoteWorktree(method: DescMethod, request: Message, supported = false): void {
  if (supported) return;

  // A new-thread schedule places its runs like CreateThread does.
  const scheduled = (schedule: ui.CreateScheduleRequest | undefined) =>
    schedule?.target === "new_thread" ? schedule.newThread?.workspaceMode : undefined;

  const mode = Match.value(method.name).pipe(
    Match.when(
      (name) => name === "CreateThread" || name === "CreateThreadWithProgress",
      () => linkedMessage(ui.CreateThreadRequestSchema, request).workspaceMode,
    ),
    Match.when("CreateSchedule", () => scheduled(linkedMessage(ui.CreateScheduleRequestSchema, request))),
    Match.when("UpdateSchedule", () => scheduled(linkedMessage(ui.UpdateScheduleRequestSchema, request).configuration)),
    Match.orElse(() => undefined),
  );

  if (
    (mode !== undefined &&
      [ui.WorkspaceMode.NEW_WORKTREE, ui.WorkspaceMode.EXISTING_WORKTREE, ui.WorkspaceMode.INHERIT_PARENT].includes(
        mode,
      )) ||
    [
      "ContinueThreadInWorktree",
      "ListGitRefs",
      "ListWorktrees",
      "CleanupWorktrees",
      "RemoveWorktree",
      "RevealWorktree",
    ].includes(method.name)
  )
    throw new ConnectError(
      "Worktrees on linked computers are not supported yet. Open Canopy on the workspace's home computer to use a worktree.",
      Code.FailedPrecondition,
    );
}
