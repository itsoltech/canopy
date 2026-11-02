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

/** Claude Code aliases the provider API does not know (the gateway refuses them too). */
const HARNESS_ALIAS = /^(default|best|opus|sonnet|haiku|fable|opusplan)(\[1m\])?$/i;

/** Gateway bots use endpoint instances, independently of availability on any worker. */
export function botWizardInstances(instances: readonly ui.ProviderInstance[], catalogs: readonly ui.WorkerModels[]): BotProviderInstance[] {
  return instances.filter((i) => i.kind === ProviderProfileKind.CLIPROXYAPI && [Provider.CLAUDE, Provider.CODEX].includes(i.harness)).map((instance) => {
    const provider = instance.harness === Provider.CLAUDE ? "CLAUDE" : "CODEX";
    const name = instance.label || instance.id;
    const models = new Map<string, ModelOption>();
    for (const catalog of catalogs) {
      const profile = catalog.profiles.find((p) => p.provider === instance.harness && p.profileId === instance.id);
      for (const info of profile?.models ?? []) {
        // Bots call the API directly: an alias is offered as the model it resolves to, never by its name.
        const id = info.resolvedModel || info.id;
        if (info.hidden || !id || HARNESS_ALIAS.test(id) || models.has(id)) continue;
        models.set(id, modelOption(provider, instance.id, name, id, catalog, "catalog"));
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
