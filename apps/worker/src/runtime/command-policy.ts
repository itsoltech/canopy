import type { Command } from "@canopy/contracts";

/** Read-only queries: answered again on redelivery instead of being remembered in the journal. */
const QUERIES: ReadonlySet<Command["kind"]["case"]> = new Set(["listMentionCatalog", "searchFiles", "generateText"]);

/** Never redelivered from an outbox (sent directly): not remembered either. */
export const NOT_REMEMBERED: ReadonlySet<Command["kind"]["case"]> = new Set([
  ...QUERIES,
  "updateTurnPermissions",
  "installCli",
  "installAgentTool",
  "probeAgentTools",
  "runAgentTool",
  "getProviderAccounts",
  "startLogin",
  "completeLogin",
  "logoutProvider",
  "readWorkspaceOrigin",
  "readGitPrContext",
  "initRepository",
  "cloneRepository",
  "cancelCloneRepository",
  "workspaceCopy",
  "botFile",
  "steerBotTurn",
  "switchThreadBranch",
  "getThreadGitStatus",
  "pullThreadOrigin",
  "listGitRefs",
  "createWorktree",
  "renameWorktreeBranch",
  "scanWorktrees",
  "revealWorktree",
  "revealPath",
  // Explicit owner actions on one file: answered once, never redelivered.
  "readFile",
  "listThreadDirectory",
  "listThreadDiff",
  "readThreadDiff",
  "getThreadFileHighlight",
  "watchThreadFiles",
  "exportThreadImage",
  "openFile",
  "revealFile",
  "writeFile",
  "deleteFile",
  "scanImportSources",
  "readImportPage",
  "readImportLibraryItem",
  // A secret header's value: never written to the journal or remembered for a retry.
  "readImportSecret",
  "adoptImportedSession",
  "removeImportedCopy",
]);

/** Scheduled checkout retries share one request ID, including after a lost acknowledgement. */
export function rememberSuccess(command: Command): boolean {
  return (
    !NOT_REMEMBERED.has(command.kind.case) ||
    (command.kind.case === "createWorktree" && command.commandId.startsWith("schedule-worktree/"))
  );
}
