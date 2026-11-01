import type { IconName } from "#lib/shared/ui/icons.ts";
import type { ConversationView } from "./model.ts";

/** An action in a menu of the Bots section (rendered by `ActionItems`). */
export interface BotAction {
  readonly label: string;
  readonly icon?: IconName | undefined;
  readonly onselect: () => void;
  readonly disabled?: boolean | undefined;
}

/** What a conversation in the list can do; a missing handler hides its item. */
export interface ConversationHandlers {
  /** Pin or unpin (pins will be a user setting in the gateway). */
  onTogglePin?: ((conversation: ConversationView) => void) | undefined;
  onMarkRead?: ((conversation: ConversationView) => void) | undefined;
}

export function conversationMenu(conversation: ConversationView, { onTogglePin, onMarkRead }: ConversationHandlers): BotAction[] {
  const items: BotAction[] = [];
  if (onTogglePin) items.push({ label: conversation.pinned ? "Unpin" : "Pin to top", icon: "star", onselect: () => onTogglePin(conversation) });
  if (onMarkRead && conversation.unread > 0) items.push({ label: "Mark as read", icon: "check", onselect: () => onMarkRead(conversation) });
  return items;
}
