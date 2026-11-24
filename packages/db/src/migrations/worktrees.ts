import worktrees from "./0066_worktrees.sql" with { type: "text" };
import worktreeLifecycle from "./0067_worktree_lifecycle.sql" with { type: "text" };
import worktreeAutomation from "./0068_worktree_automation.sql" with { type: "text" };
import worktreeBranchNames from "./0087_worktree_branch_names.sql" with { type: "text" };
import externalWorktrees from "./0092_external_worktrees.sql" with { type: "text" };
import threadWorktreePreparation from "./0167_thread_worktree_preparation.sql" with { type: "text" };
import scheduleWorktreePreparations from "./0174_schedule_worktree_preparations.sql" with { type: "text" };
import removedBranchCleanup from "./0179_removed_branch_cleanup.sql" with { type: "text" };
import threadWorktreeSwitch from "./0213_thread_worktree_switch.sql" with { type: "text" };
import { sqlFile } from "./run.ts";

export const worktreeMigrations = {
  "0066_worktrees": sqlFile(worktrees),
  "0067_worktree_lifecycle": sqlFile(worktreeLifecycle),
  "0068_worktree_automation": sqlFile(worktreeAutomation),
  "0087_worktree_branch_names": sqlFile(worktreeBranchNames),
  "0092_external_worktrees": sqlFile(externalWorktrees),
  "0167_thread_worktree_preparation": sqlFile(threadWorktreePreparation),
  "0174_schedule_worktree_preparations": sqlFile(scheduleWorktreePreparations),
  "0179_removed_branch_cleanup": sqlFile(removedBranchCleanup),
  "0213_thread_worktree_switch": sqlFile(threadWorktreeSwitch),
};
