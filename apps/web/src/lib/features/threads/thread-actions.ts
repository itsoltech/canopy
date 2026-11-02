import type { ui } from "@open-agents/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";

export type ThreadActionId = "open" | "new" | "pin" | "rename" | "regenerate" | "read" | "filter" | "settings" | "archive" | "delete";
export interface ThreadAction { id: ThreadActionId; label: string; icon: IconName; disabled?: boolean; group: number; }

/** State-dependent labels and availability shared by the row menu and command palette. */
export function threadActions(thread: ui.Thread, projectName: string, pinned: boolean): ThreadAction[] {
  if (thread.deletedAt) return [];
  const archived = thread.status === "archived";
  return [
    { id: "open", label: "Open in new tab", icon: "arrow-top-right-on-square", group: 0 },
    { id: "new", label: `New thread in ${projectName}`, icon: "pencil-square", group: 0 },
    { id: "pin", label: pinned ? "Unpin thread" : "Pin thread", icon: "star", group: 1 },
    { id: "rename", label: "Rename…", icon: "pencil-square", disabled: archived, group: 1 },
    { id: "regenerate", label: "Regenerate title", icon: "arrow-path", disabled: archived || thread.titleGenerating || thread.lastSeq === 0n, group: 1 },
    { id: "read", label: thread.markedUnread || thread.unseenResult ? "Mark as read" : "Mark as unread", icon: "chat-bubble-left", group: 1 },
    { id: "filter", label: `Filter by ${projectName}`, icon: "bars-3", group: 2 },
    { id: "settings", label: "Project settings", icon: "cog-6-tooth", group: 2 },
    { id: "archive", label: archived ? (thread.archivedBy === "cascade" ? "Unarchive with parent" : "Unarchive") : "Archive thread", icon: "archive-box", group: 3 },
    { id: "delete", label: "Delete…", icon: "trash", group: 3 },
  ];
}
