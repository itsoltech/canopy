import type { WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
import type { ThreadState } from "../threads/ThreadScreen";
import { PullRequestScreen } from "../github/PullRequestScreen";
import { Notice } from "../../ui/components";
import { WorkspaceTask } from "./WorkspaceTask";

/** A full tab beside the thread: one pull request or one background task's output. */
export function WorkspaceModule({ state, target }: { state: ThreadState; target: WorkspaceModuleTarget }) {
  if (target.module === "pull-requests" && target.resource)
    return <PullRequestScreen id={target.resource} threadId={state.thread?.id} embedded />;

  if (target.module === "tasks" && target.resource) return <WorkspaceTask state={state} id={target.resource} />;

  return <Notice>This tab is no longer available. Close it to continue.</Notice>;
}
