import { untrack } from "svelte";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { applyBotConversation } from "@canopy/domain/bot-snapshot";
import { botViewKey } from "@canopy/domain/bot-cache";
import { liveSource } from "#lib/shared/live-source.ts";
import { decode } from "#lib/shared/wire.ts";
import { botCache } from "./cache.ts";
import { botList } from "./bot-list.svelte.ts";
import { prependBotPage } from "@canopy/domain/history-pages";
import { bodyJson } from "#lib/shared/json.ts";

/** Reconnect reads the last applied checkpoint; a cache mismatch retries a full state. */
export function watchBot(bot: () => bots.Bot, receive: (next: bots.BotConversation) => void) {
  let live = $state(false);
  let loaded = $state(false);
  let retry = $state(0);
  let hasMore = $state(false);
  let loadingOlder = $state(false);
  let historyError = $state("");
  let loadOlder = async () => {};

  $effect(() => {
    const initial = bot();
    const key = botViewKey("chat", initial.id);
    void retry;
    let snapshot = botCache.get(key)?.conversation;
    let cursor = snapshot?.cursor ?? "";
    const abort = new AbortController();
    live = false;
    loaded = !!snapshot;
    untrack(() => receive(snapshot ?? create(bots.BotConversationSchema, { bot: initial })));

    const stop = liveSource(`/api/bots/${initial.id}/events`, {
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
        hasMore = snapshot.historyHasMore;
      },
    });

    loadOlder = async () => {
      if (!snapshot?.historyHasMore || loadingOlder) return;
      loadingOlder = true;
      historyError = "";
      const checkpoint = cursor;

      try {
        const query = new URLSearchParams({ before: String(snapshot.historyBeforeSeq), cursor });
        const response = await fetch(`/api/bots/${initial.id}/history?${query}`, { signal: abort.signal });

        if (!response.ok) throw new Error("History unavailable");
        const page = decode(bots.BotConversationSchema, await bodyJson(response));

        if (abort.signal.aborted) return;

        try {
          snapshot = prependBotPage(snapshot, page, checkpoint);
        } catch {
          snapshot = { ...snapshot, cursor: "" };
        }

        botCache.set(create(bots.BotCachedViewSchema, { key, conversation: snapshot }));
        receive(snapshot);
        live = false;
        stop();
        retry++;
      } catch {
        if (!abort.signal.aborted) historyError = "Could not load earlier messages. Try again.";
      } finally {
        loadingOlder = false;
      }
    };

    return () => {
      stop();
      abort.abort();
    };
  });

  return {
    get historyError() {
      return historyError;
    },
    loadOlder: () => loadOlder(),
    get hasMore() {
      return hasMore;
    },
    get loadingOlder() {
      return loadingOlder;
    },
    get live() {
      return live;
    },
    get loaded() {
      return loaded;
    },
  };
}
