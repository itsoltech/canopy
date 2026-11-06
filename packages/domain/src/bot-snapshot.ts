import { bots } from "@canopy/contracts";

type History = Pick<bots.BotConversation, "messages" | "cursor" | "baseCursor" | "delta" | "removedMessageIds">;

/** Atomic cursor validation comes before merging: a missed checkpoint must reopen without a cursor. */
function merge(previous: History | undefined, next: History) {
  if (!next.delta) return next.messages;

  if (!previous || !previous.cursor || previous.cursor !== next.baseCursor) throw new Error("Bot checkpoint mismatch");
  const removed = new Set(next.removedMessageIds);
  const upserts = new Map(next.messages.map((message) => [message.id, message]));
  const messages = previous.messages.filter((message) => !removed.has(message.id) && !upserts.has(message.id));

  if (!next.messages.length && messages.length === previous.messages.length) return previous.messages;

  return [...messages, ...next.messages].sort((a, b) =>
    a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id.localeCompare(b.id),
  );
}

export function applyBotConversation(
  previous: bots.BotConversation | undefined,
  next: bots.BotConversation,
): bots.BotConversation {
  if (previous?.bot && next.bot && previous.bot.id !== next.bot.id && next.delta)
    throw new Error("Bot identity mismatch");

  const controls = next.controlsUnchanged ? previous : next;

  if (!controls) throw new Error("Missing bot control state");

  return {
    ...controls,
    cursor: next.cursor,
    messages: merge(previous, next),
    delta: false,
    baseCursor: "",
    removedMessageIds: [],
    controlsUnchanged: false,
  };
}

export function applyBotExchange(
  previous: bots.ReadBotExchangeResponse | undefined,
  next: bots.ReadBotExchangeResponse,
): bots.ReadBotExchangeResponse {
  const messages = merge(previous, next);
  const controls = next.controlsUnchanged ? previous : next;

  if (!controls) throw new Error("Missing exchange control state");

  return {
    ...next,
    messages,
    participants: controls.participants,
    controlsUnchanged: false,
    delta: false,
    baseCursor: "",
    removedMessageIds: [],
  };
}

/** A cached card is display-only until this subscription has confirmed the current full control state. */
export function canAnswerBotApproval(conversation: bots.BotConversation | undefined, id: string, live: boolean) {
  return (
    live &&
    !!conversation?.bot &&
    !conversation.bot.archived &&
    conversation.approvals.some((a) => a.id === id && a.status === "pending")
  );
}

/** Shared mutation boundary: UI disabling is supplemented by a fresh subscription check. */
export async function answerLiveBotApproval<T>(
  conversation: bots.BotConversation | undefined,
  request: bots.AnswerBotApprovalRequest,
  live: boolean,
  send: (request: bots.AnswerBotApprovalRequest) => Promise<T>,
) {
  if (!canAnswerBotApproval(conversation, request.approvalId, live))
    throw new Error("This conversation is still syncing.");

  return send(request);
}
