import { Provider, type bots, type ui } from "@canopy/contracts";
import { modelOption, type ModelOption } from "#lib/features/models/catalog.ts";
import { instanceKeyOf, instanceName } from "#lib/features/providers/instances.ts";
import type { BotProviderInstance } from "./wizard/draft.ts";
import {
  approvalView,
  botEntries,
  botParticipant,
  dateOf,
  displayText,
  exchangeEntries,
  type ConversationView,
} from "@canopy/domain/bot-chat";

export { approvalView, botEntries, botParticipant, displayText, exchangeEntries };

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
    createdAt: bot.createdAt ? dateOf(bot.createdAt) : undefined,
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
