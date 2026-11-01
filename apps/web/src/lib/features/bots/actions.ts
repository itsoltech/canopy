import type { MenuItem } from "./components/Menu.svelte";
import type { ConversationView } from "./model.ts";

/** What a conversation in the list can do; a missing handler hides its item. */
export interface ConversationHandlers {
  /** Pin or unpin (pins will be a user setting in the gateway). */
  onTogglePin?: ((conversation: ConversationView) => void) | undefined;
  onMarkRead?: ((conversation: ConversationView) => void) | undefined;
}

export function conversationMenu(conversation: ConversationView, { onTogglePin, onMarkRead }: ConversationHandlers): MenuItem[] {
  const items: MenuItem[] = [];
  if (onTogglePin) items.push({ label: conversation.pinned ? "Unpin" : "Pin to top", icon: "star", onselect: () => onTogglePin(conversation) });
  if (onMarkRead && conversation.unread > 0) items.push({ label: "Mark as read", icon: "check", onselect: () => onMarkRead(conversation) });
  return items;
}
