import type { IconName } from "#lib/shared/ui/icons.ts";
import type { ConversationView } from "@canopy/domain/bot-chat";

/** An action in a menu of the Bots section (rendered by `ActionItems`). */
export interface BotAction {
  readonly label: string;
  readonly icon?: IconName | undefined;
  readonly onselect: () => void;
  readonly disabled?: boolean | undefined;
}

/** What a conversation in the list can do; a missing handler hides its item. */
export interface ConversationHandlers {
  onEdit?: ((conversation: ConversationView) => void) | undefined;
  onArchive?: ((conversation: ConversationView) => void | Promise<void>) | undefined;
  onDelete?: ((conversation: ConversationView) => void) | undefined;
  /** Pin or unpin (pins will be a user setting in the gateway). */
  onTogglePin?: ((conversation: ConversationView) => void) | undefined;
  onMarkRead?: ((conversation: ConversationView) => void) | undefined;
  /** "Move to…" another linked computer (stage 8); only for this computer's own bots. */
  onMove?: ((conversation: ConversationView) => void) | undefined;
}

export function conversationMenu(
  conversation: ConversationView,
  { onTogglePin, onMarkRead, onEdit, onArchive, onDelete, onMove }: ConversationHandlers,
): BotAction[] {
  const items: BotAction[] = [];

  if (onEdit && conversation.kind === "direct")
    items.push({ label: "Edit bot…", icon: "pencil-square", onselect: () => onEdit(conversation) });

  if (onTogglePin)
    items.push({
      label: conversation.pinned ? "Unpin" : "Pin to top",
      icon: "star",
      onselect: () => onTogglePin(conversation),
    });

  if (onMarkRead && conversation.unread > 0)
    items.push({ label: "Mark as read", icon: "check", onselect: () => onMarkRead(conversation) });

  if (onMove && conversation.kind === "direct" && !conversation.nodeId)
    items.push({ label: "Move to…", icon: "arrows-right-left", onselect: () => onMove(conversation) });

  if (onArchive)
    items.push({
      label: conversation.archived ? "Unarchive bot" : "Archive bot",
      icon: "archive-box",
      onselect: () => void onArchive(conversation),
    });

  if (onDelete && conversation.archived)
    items.push({ label: "Delete bot…", icon: "trash", onselect: () => onDelete(conversation) });

  return items;
}
