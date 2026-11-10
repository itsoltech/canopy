import type { ui } from "@canopy/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";

export type ThreadActionId =
  | "open"
  | "new"
  | "pin"
  | "rename"
  | "regenerate"
  | "read"
  | "reveal"
  | "filter"
  | "settings"
  | "move"
  | "archive"
  | "delete";

export interface ThreadAction {
  id: ThreadActionId;
  label: string;
  icon: IconName;
  disabled?: boolean;
  group: number;
}

/** State-dependent labels and availability shared by the row menu and command palette. */
export function threadActions(
  thread: ui.Thread,
  projectName: string,
  pinned: boolean,
  readOnly = false,
  linkedComputers = false,
  /** The thread's folder is on the computer showing it (onThisComputer): only then can it open there. */
  local = false,
): ThreadAction[] {
  if (thread.deletedAt) return [];
  const archived = thread.status === "archived";

  const actions: ThreadAction[] = [
    { id: "open", label: "Open in new tab", icon: "arrow-top-right-on-square", group: 0 },
    { id: "new", label: `New thread in ${projectName}`, icon: "pencil-square", group: 0 },
    { id: "pin", label: pinned ? "Unpin thread" : "Pin thread", icon: "star", group: 1 },
    { id: "rename", label: "Rename…", icon: "pencil-square", disabled: archived, group: 1 },
    {
      id: "regenerate",
      label: "Regenerate title",
      icon: "arrow-path",
      disabled: archived || thread.titleGenerating || thread.lastSeq === 0n,
      group: 1,
    },
    {
      id: "read",
      label: thread.markedUnread || thread.unseenResult ? "Mark as read" : "Mark as unread",
      icon: "chat-bubble-left",
      group: 1,
    },
    // This computer's file manager opens the thread's directory (worktree or checkout).
    ...(local && thread.cwd
      ? [{ id: "reveal" as const, label: "Open folder", icon: "folder" as const, group: 2 }]
      : []),
    { id: "filter", label: `Filter by ${projectName}`, icon: "bars-3", group: 2 },
    { id: "settings", label: "Project settings", icon: "cog-6-tooth", group: 2 },
    // Stage 8: only this computer's own main threads; side threads move with their parent.
    ...(linkedComputers && !thread.nodeId && !thread.parentThreadId
      ? [{ id: "move" as const, label: "Move to…", icon: "arrows-right-left" as const, group: 3 }]
      : []),
    {
      id: "archive",
      label: archived ? (thread.archivedBy === "cascade" ? "Unarchive with parent" : "Unarchive") : "Archive thread",
      icon: "archive-box",
      group: 3,
    },
    { id: "delete", label: "Delete…", icon: "trash", group: 3 },
  ];

  return readOnly ? actions.map((action) => ({ ...action, disabled: true })) : actions;
}

/**
 * The thread's folder and files are on the computer showing it: the desktop app runs its own gateway (local
 * mode) and the thread's worker is that app's bundled worker. A linked computer's thread, another enrolled
 * worker or a browser elsewhere would open the folder on a different machine.
 */
export const onThisComputer = (thread: ui.Thread, worker: ui.Worker | undefined, ownGateway: boolean): boolean =>
  ownGateway && !thread.nodeId && worker?.desktopBundled === true && !worker.nodeId;
