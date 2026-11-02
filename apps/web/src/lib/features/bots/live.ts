import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderProfileKind, type bots, type ui } from "@open-agents/contracts";
import { modelOption, type ModelOption } from "#lib/features/models/catalog.ts";
import { instanceKeyOf } from "#lib/features/providers/instances.ts";
import type { BotProviderInstance } from "./wizard/draft.ts";
import type { BotView, ChatEntry, ConversationView } from "./model.ts";

export function botParticipant(bot: bots.Bot): BotView {
  return { id: bot.id, kind: "bot", name: bot.configuration?.name ?? "Bot", shape: bot.configuration?.shape, color: bot.configuration?.color };
}
export function botConversation(bot: bots.Bot, pinnedIds: readonly string[] = []): ConversationView {
  const last = bot.lastMessage;
  return { id: bot.id, kind: "direct", bots: [botParticipant(bot)], unread: 0, pinned: pinnedIds.includes(bot.id), pinOrder: pinnedIds.indexOf(bot.id),
    ...(last && { lastMessage: { senderId: last.senderId, text: last.text, at: last.createdAt ? timestampDate(last.createdAt) : new Date(0) } }),
  };
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

/** Gateway bots use endpoint instances, independently of availability on any worker. */
export function botWizardInstances(instances: readonly ui.ProviderInstance[], catalogs: readonly ui.WorkerModels[]): BotProviderInstance[] {
  return instances.filter((i) => i.kind === ProviderProfileKind.CLIPROXYAPI && [Provider.CLAUDE, Provider.CODEX].includes(i.harness)).map((instance) => {
    const provider = instance.harness === Provider.CLAUDE ? "CLAUDE" : "CODEX";
    const name = instance.label || instance.id;
    const models = new Map<string, ModelOption>();
    for (const catalog of catalogs) {
      const profile = catalog.profiles.find((p) => p.provider === instance.harness && p.profileId === instance.id);
      for (const info of profile?.models ?? []) {
        if (!info.hidden && info.id && !models.has(info.id)) models.set(info.id, modelOption(provider, instance.id, name, info.id, catalog, "catalog"));
      }
    }
    // Custom models remain usable when no worker has ever reported this instance.
    for (const id of instance.models?.custom ?? []) {
      if (!models.has(id) && !instance.models?.hidden.includes(id)) models.set(id, { ...modelOption(provider, instance.id, name, id, undefined), efforts: [], defaultEffort: undefined });
    }
    const favorites = instance.models?.favorites ?? [];
    const rank = (id: string) => favorites.includes(id) ? favorites.indexOf(id) : favorites.length;
    return { id: instanceKeyOf(instance), name, provider, models: [...models.values()].sort((a, b) => rank(a.model) - rank(b.model)) };
  });
}
