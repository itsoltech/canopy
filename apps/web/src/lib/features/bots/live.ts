import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Provider, type bots, type ui } from "@canopy/contracts";
import { modelOption, type ModelOption } from "#lib/features/models/catalog.ts";
import { instanceKeyOf, instanceName } from "#lib/features/providers/instances.ts";
import type { BotProviderInstance } from "./wizard/draft.ts";
import type { ApprovalView, BotView, ChatEntry, ConversationView, QuestionView } from "./model.ts";

export function botParticipant(bot: bots.Bot): BotView {
  return {
    id: bot.id,
    kind: "bot",
    name: bot.configuration?.name ?? "Bot",
    shape: bot.configuration?.shape,
    color: bot.configuration?.color,
  };
}

export function botConversation(bot: bots.Bot, pinnedIds: readonly string[] = []): ConversationView {
  const last = bot.lastMessage;

  return {
    id: bot.id,
    nodeId: bot.nodeId,
    kind: "direct",
    bots: [botParticipant(bot)],
    unread: bot.unreadCount,
    archived: bot.archived,
    pinned: !bot.archived && pinnedIds.includes(bot.id),
    pinOrder: pinnedIds.indexOf(bot.id),
    ...(last && {
      lastMessage: {
        senderId: last.senderId === "user" ? "me" : last.senderId,
        text: displayText(last),
        at: dateOf(last.createdAt),
        failed: last.failed,
      },
    }),
  };
}

const dateOf = (at: Timestamp | undefined) => (at ? timestampDate(at) : new Date(0));

/** "Message from Grok Bot: hi" (what the receiving bot's model reads) is shown as "hi". */
const relayed = /^Message from [^:\n]{1,80}: /;

/** Text of a stored message as people read it: relays without their prefix, thread results by their first line. */
function displayText(message: bots.BotMessage): string {
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
    askedBy: a.botId,
    prompt: a.prompt,
    options,
    freeText: true,
    routineTitle: a.routineTitle || undefined,
    ...(a.status !== "pending" && {
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
    askedBy: a.botId,
    action: heading.replace(/^Needs approval · /, "") || "Use a tool",
    fields,
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

/** Models reported by workers for each official harness instance. */
export function botWizardInstances(
  instances: readonly ui.ProviderInstance[],
  catalogs: readonly ui.WorkerModels[],
): BotProviderInstance[] {
  return instances.flatMap((instance) => {
    if (![Provider.CLAUDE, Provider.CODEX, Provider.GROK].includes(instance.harness)) return [];

    const provider =
      instance.harness === Provider.CLAUDE ? "CLAUDE" : instance.harness === Provider.GROK ? "GROK" : "CODEX";

    const name = instanceName(instance);
    const models = new Map<string, ModelOption>();

    for (const catalog of catalogs) {
      const profile = catalog.profiles.find((p) => p.provider === instance.harness && p.profileId === instance.id);

      for (const info of profile?.models ?? []) {
        const id = info.id;

        if (info.hidden || !id || models.has(id)) continue;
        models.set(id, modelOption(provider, instance.id, name, id, catalog, "catalog"));
      }
    }

    // Custom models remain usable when no worker has ever reported this instance.
    for (const id of instance.models?.custom ?? []) {
      if (!models.has(id) && !instance.models?.hidden.includes(id))
        models.set(id, {
          ...modelOption(provider, instance.id, name, id, undefined),
          efforts: [],
          defaultEffort: undefined,
        });
    }

    const favorites = instance.models?.favorites ?? [];
    const rank = (id: string) => (favorites.includes(id) ? favorites.indexOf(id) : favorites.length);

    return [
      {
        id: instanceKeyOf(instance),
        name,
        provider,
        models: [...models.values()].sort((a, b) => rank(a.model) - rank(b.model)),
        automaticModels: [...models.values()].filter(
          (model) =>
            instance.models?.custom.includes(model.model) ||
            catalogs.some(
              (c) =>
                !c.workerId.includes("~") &&
                c.profiles.some(
                  (p) =>
                    p.provider === instance.harness &&
                    p.profileId === instance.id &&
                    p.models.some((m) => !m.hidden && m.id === model.model),
                ),
            ),
        ),
        modelsByWorker: new Map(
          catalogs.map((catalog) => {
            const profile = catalog.profiles.find(
              (p) => p.provider === instance.harness && p.profileId === instance.id,
            );

            return [
              catalog.workerId,
              (profile?.models ?? [])
                .filter((m) => !m.hidden)
                .map((m) => modelOption(provider, instance.id, name, m.id, catalog, "catalog")),
            ];
          }),
        ),
      },
    ];
  });
}

export function botInstancesOnWorker(
  instances: readonly BotProviderInstance[],
  workerId: string,
): readonly BotProviderInstance[] {
  if (workerId) return instances.map((i) => ({ ...i, models: i.modelsByWorker?.get(workerId) ?? [] }));

  return instances.map((instance) => ({ ...instance, models: instance.automaticModels ?? instance.models }));
}
