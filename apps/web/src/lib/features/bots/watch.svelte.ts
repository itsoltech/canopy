import { untrack } from "svelte";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { applyBotConversation } from "@canopy/domain/bot-snapshot";
import { botViewKey } from "@canopy/domain/bot-cache";
import { liveSource } from "#lib/shared/live-source.ts";
import { decode } from "#lib/shared/wire.ts";
import { botCache } from "./cache.ts";
import { botList } from "./bot-list.svelte.ts";

/** Reconnect reads the last applied checkpoint; a cache mismatch retries a full state. */
export function watchBot(bot: () => bots.Bot, receive: (next: bots.BotConversation) => void) {
  let live = $state(false);
  let loaded = $state(false);
  let retry = $state(0);

  $effect(() => {
    const initial = bot();
    const key = botViewKey("chat", initial.id);
    const attempt = retry;
    let snapshot = botCache.get(key)?.conversation;
    let cursor = attempt ? "" : (snapshot?.cursor ?? "");
    live = false;
    loaded = !!snapshot;
    untrack(() => receive(snapshot ?? create(bots.BotConversationSchema, { bot: initial })));

    return liveSource(`/api/bots/${initial.id}/events`, {
      url: () => `/api/bots/${initial.id}/events?incremental=1&cursor=${encodeURIComponent(cursor)}`,
      ondrop: () => (live = false),
      onmessage: (json) => {
        try {
          snapshot = applyBotConversation(snapshot, decode(bots.BotConversationSchema, JSON.parse(json)));
        } catch {
          botCache.delete(key);
          live = false;
          retry++;

          return;
        }

        cursor = snapshot.cursor;
        botCache.set(create(bots.BotCachedViewSchema, { key, conversation: snapshot }));
        receive(snapshot);

        if (snapshot.bot) botList.upsert(snapshot.bot);
        loaded = true;
        live = true;
      },
    });
  });

  return {
    get live() {
      return live;
    },
    get loaded() {
      return loaded;
    },
  };
}
