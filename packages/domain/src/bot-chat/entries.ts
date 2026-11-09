import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Provider, type bots } from "@canopy/contracts";
import type { ApprovalView, BotView, ChatEntry, QuestionView } from "./model.ts";

/** A bot's chat (bots.BotConversation) as chat entries and participants (model.ts), for every client. */

export function botParticipant(bot: bots.Bot): BotView {
  return {
    id: bot.id,
    kind: "bot",
    name: bot.configuration?.name ?? "Bot",
    shape: bot.configuration?.shape,
    color: bot.configuration?.color,
  };
}

export const dateOf = (at: Timestamp | undefined) => (at ? timestampDate(at) : new Date(0));

/** "Message from Grok Bot: hi" (what the receiving bot's model reads) is shown as "hi". */
const relayed = /^Message from [^:\n]{1,80}: /;

/** Text of a stored message as people read it: relays without their prefix, thread results by their first line. */
export function displayText(message: bots.BotMessage): string {
  if (message.exchangeId && relayed.test(message.text)) return message.text.replace(relayed, "");

  if (message.kind === "event") return message.text.split("\n", 1)[0]!.replace(/ \([0-9a-f-]{36}\)/, "");

  return message.text;
}

/** A bot ⇄ bot message in this bot's chat (its reply to you stays a bubble, even within an exchange). */
const isExchange = (m: bots.BotMessage) =>
  Boolean(m.exchangeId) && m.senderId !== "user" && !(m.kind === "message" && m.recipientId === "user");

export function botEntries(snapshot: bots.BotConversation): ChatEntry[] {
  const botId = snapshot.bot?.id ?? "";
  const last = snapshot.messages.at(-1);

  const entries: ChatEntry[] = snapshot.messages.map((m): ChatEntry => {
    const at = dateOf(m.createdAt);

    if (m.failed)
      return {
        kind: "error",
        error: {
          id: m.id,
          botId: m.senderId,
          at,
          detail: m.text,
          code: m.errorCode,
          source: m.errorSource,
          retryable: m === last && !snapshot.working && !snapshot.approvals.some((a) => a.status === "pending"),
        },
      };

    if (isExchange(m)) {
      const sent = m.senderId === botId;

      return {
        kind: "exchange",
        exchange: {
          id: m.id,
          exchangeId: m.exchangeId,
          at,
          counterpartId: sent ? m.recipientId : m.senderId,
          direction: sent ? "sent" : "received",
        },
      };
    }

    if (m.settingChanges.length)
      return {
        kind: "event",
        event: { id: m.id, at, kind: "info", text: m.text, actorId: botId, changes: m.settingChanges },
      };

    if (m.kind === "event")
      return {
        kind: "event",
        event: {
          id: m.id,
          at,
          kind: m.senderId === "system" ? "routine_created" : "info",
          text: m.senderId === "system" ? "Reminder" : displayText(m),
          ...(m.senderId === "system" && { detail: m.text }),
          actorId: m.senderId,
        },
      };

    return {
      kind: "message",
      message: {
        id: m.id,
        at,
        senderId: m.senderId === "user" ? "me" : m.senderId,
        text: m.text,
        mentions: m.mentions,
        quotes: m.quotes,
        attachments: m.attachments,
      },
    };
  });

  for (const a of snapshot.approvals)
    entries.push(
      a.kind === "question"
        ? { kind: "question", question: questionView(a) }
        : { kind: "approval", approval: approvalView(a) },
    );

  if (snapshot.streamingText)
    entries.push({
      kind: "message",
      message: { id: `stream:${botId}`, at: dateOf(last?.createdAt), senderId: botId, text: snapshot.streamingText },
    });

  return entries;
}

function questionView(a: bots.BotApproval): QuestionView {
  const options = a.options.map((label, index) => ({ id: `option:${index}`, label }));
  const chosen = options.find((o) => o.label === a.answer);

  return {
    id: a.id,
    at: dateOf(a.createdAt),
    expiresAt: a.expiresAt ? dateOf(a.expiresAt) : undefined,
    askedBy: a.botId,
    prompt: a.prompt,
    options,
    freeText: true,
    expired: a.status === "expired",
    routineTitle: a.routineTitle || undefined,
    ...(!["pending", "expired"].includes(a.status) && {
      answer: {
        optionId: chosen?.id ?? "",
        at: dateOf(a.createdAt),
        text: a.answer,
        skipped: a.status === "discarded",
      },
    }),
  };
}

function approvalStatus(a: bots.BotApproval): ApprovalView["status"] {
  if (a.status === "expired") return "expired";

  if (a.status === "approved") return "approved";

  if (a.status === "discarded") return a.answer ? "edited" : "discarded";

  return "pending";
}

/** The gateway's approval text: "Needs approval · Sending to Notion" and then one "Label: value" per line. */
export function approvalView(a: bots.BotApproval): ApprovalView {
  const [heading = "", ...lines] = a.prompt.split("\n");

  const fields = lines
    .filter((line) => line.trim())
    .map((line) => {
      const colon = line.indexOf(": ");

      return colon > 0 && colon < 60
        ? { label: line.slice(0, colon), value: line.slice(colon + 2) }
        : { label: "", value: line };
    });

  const status = approvalStatus(a);

  const proposal = a.proposedBot;

  return {
    id: a.id,
    at: dateOf(a.createdAt),
    expiresAt: a.expiresAt ? dateOf(a.expiresAt) : undefined,
    askedBy: a.botId,
    action: heading.replace(/^Needs approval · /, "") || "Use a tool",
    ruleOptions: a.ruleOptions,
    allowedByRule: a.allowedByRule,
    threadId: a.threadId || undefined,
    fields: a.fields.length ? a.fields : fields,
    status,
    routineTitle: a.routineTitle || undefined,
    botProposal: proposal
      ? {
          name: proposal.name,
          shape: proposal.shape,
          color: proposal.color,
          model: proposal.model,
          effort: proposal.effort,
          provider:
            proposal.provider === Provider.CLAUDE ? "Claude" : proposal.provider === Provider.GROK ? "Grok" : "Codex",
          instance: proposal.providerInstance,
          approvalPolicy: proposal.approvalPolicy,
          instructions: proposal.instructions,
        }
      : undefined,
  };
}

/** Messages of one bot ⇄ bot exchange, each from the bot that wrote it. */
export function exchangeEntries(messages: readonly bots.BotMessage[]): ChatEntry[] {
  return messages.map((m) => ({
    kind: "message",
    message: { id: m.id, at: dateOf(m.createdAt), senderId: m.senderId, text: displayText(m) },
  }));
}
