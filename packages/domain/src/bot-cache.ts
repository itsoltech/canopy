import { toBinary } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";

export const botCacheLimits = { count: 16, bytes: 32 * 1024 * 1024, entry: 8 * 1024 * 1024 };
export const botViewKey = (kind: "chat" | "exchange", id: string) => `${kind}_${id}`;

export const botViewOwners = (view: bots.BotCachedView) =>
  view.conversation?.bot
    ? [view.conversation.bot.id]
    : [
        ...new Set([
          ...(view.exchange?.participants.map((bot) => bot.id) ?? []),
          ...(view.exchange?.messages.map((message) => message.botId) ?? []),
        ]),
      ];

/** Separate from thread budgets: bot chats and exchanges compete in one bounded LRU. */
export class BotViewCache {
  #entries = new Map<string, { view: bots.BotCachedView; bytes: number }>();
  #bytes = 0;
  #available: Set<string> | undefined;

  constructor(readonly limits = botCacheLimits) {}

  get(key: string) {
    const entry = this.#entries.get(key);

    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return entry.view;
  }

  set(view: bots.BotCachedView, bytes = toBinary(bots.BotCachedViewSchema, view).byteLength) {
    this.delete(view.key);
    const participants = view.conversation?.bot ? [view.conversation.bot] : (view.exchange?.participants ?? []);

    if (
      bytes > this.limits.entry ||
      bytes > this.limits.bytes ||
      participants.some((bot) => bot.archived) ||
      (this.#available && botViewOwners(view).some((id) => !this.#available?.has(id)))
    )
      return;
    this.#entries.set(view.key, { view, bytes });
    this.#bytes += bytes;

    while (this.#entries.size > this.limits.count || this.#bytes > this.limits.bytes) {
      const oldest = this.#entries.keys().next().value;

      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  reconcile(list: readonly bots.Bot[]) {
    const available = new Set(list.flatMap((bot) => (bot.archived ? [] : [bot.id])));
    this.#available = available;

    for (const [key, { view }] of this.#entries)
      if (botViewOwners(view).some((id) => !available.has(id))) this.delete(key);
  }

  delete(key: string) {
    this.#bytes -= this.#entries.get(key)?.bytes ?? 0;
    this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
    this.#available = undefined;
  }
}
