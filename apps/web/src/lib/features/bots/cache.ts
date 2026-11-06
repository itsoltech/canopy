import { BotViewCache } from "@canopy/domain/bot-cache";
import { bots } from "@canopy/contracts";
import { loadHistory, saveHistory, reconcileBotHistory } from "../desktop/history.ts";

/** SPA memory, with private Electron persistence when the preload bridge is available. */
class ClientBotCache extends BotViewCache {
  async load(key: string) {
    const cached = this.get(key) ?? (await loadHistory(bots.BotCachedViewSchema, key));

    if (cached?.key === key) super.set(cached);

    return this.get(key);
  }
  override set(view: bots.BotCachedView, bytes?: number) {
    super.set(view, bytes);

    if (this.get(view.key)) saveHistory(bots.BotCachedViewSchema, view.key, view);
  }
  override reconcile(list: readonly bots.Bot[]) {
    super.reconcile(list);
    reconcileBotHistory(list.flatMap((bot) => (bot.archived ? [] : [bot.id])));
  }
}

export const botCache = new ClientBotCache();
