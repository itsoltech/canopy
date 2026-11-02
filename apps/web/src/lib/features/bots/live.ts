import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { bots } from "@open-agents/contracts";
import type { BotView, ChatEntry, ConversationView } from "./model.ts";

export function botParticipant(bot: bots.Bot): BotView {
  return { id: bot.id, kind: "bot", name: bot.configuration?.name ?? "Bot", shape: bot.configuration?.shape, color: bot.configuration?.color };
}
export function botConversation(bot: bots.Bot, pinnedIds: readonly string[] = []): ConversationView {
  return { id: bot.id, kind: "direct", bots: [botParticipant(bot)], unread: 0, pinned: pinnedIds.includes(bot.id), pinOrder: pinnedIds.indexOf(bot.id) };
}
export function botEntries(snapshot: bots.BotConversation): ChatEntry[] {
  const messages: ChatEntry[] = snapshot.messages.map((m) => {
    const at = m.createdAt ? timestampDate(m.createdAt) : new Date(0);
    return m.kind === "event" ? { kind: "event", event: { id: m.id, at, kind: "info", text: m.text, actorId: m.senderId } }
      : { kind: "message", message: { id: m.id, at, senderId: m.senderId === "user" ? "me" : m.senderId, text: m.text } };
  });
  const approvals: ChatEntry[] = snapshot.approvals.map((a) => ({ kind: "question", question: {
    id: a.id, at: a.createdAt ? timestampDate(a.createdAt) : new Date(0), askedBy: a.botId, prompt: a.prompt,
    freeText: a.kind === "question" && a.status === "pending",
    options: a.kind === "question" ? [...(a.status === "approved" ? [{ id: "answer", label: a.answer }] : []), { id: "discard", label: "Discard" }]
      : [{ id: "approve", label: "Approve" }, { id: "discard", label: "Discard" }],
    ...(a.status !== "pending" && { answer: { optionId: a.status === "approved" ? a.kind === "question" ? "answer" : "approve" : "discard", at: a.createdAt ? timestampDate(a.createdAt) : new Date(0) } }),
  } }));
  return [...messages, ...approvals];
}

/** Stable seam for feat/bots-wizard: the wizard's oncreate payload enters here. */
export interface BotWizardResult {
  name: string; shape: string; color: string;
  providerInstance: { id: string; harness: import("@open-agents/contracts").Provider };
  model: string; effort: string;
}
