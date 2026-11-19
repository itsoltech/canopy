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

export function watchBot(botId: () => string) {
  let watch = $state.raw<ReturnType<typeof openBotWatch>>();
  // Navigation can render the new chat before the subscription effect has run.
  const active = $derived(watch?.id === botId() ? watch : undefined);

  $effect(() => {
    const id = botId();
    const view = untrack(() => openBotWatch(id));
    watch = view;

    return view.close;
  });

  return {
    get snapshot() {
      return active?.snapshot;
    },
    get historyError() {
      return active?.historyError ?? "";
    },
    loadOlder: async () => active?.loadOlder(),
    get loadingOlder() {
      return active?.loadingOlder ?? false;
    },
    get live() {
      return active?.live ?? false;
    },
  };
}

function openBotWatch(id: string) {
  const key = botViewKey("chat", id);
  const url = `/api/bots/${id}`;
  const abort = new AbortController();
  let snapshot = $state.raw(botCache.get(key)?.conversation);
  let live = $state(false);
  let loadingOlder = $state(false);
  let historyError = $state("");
  let olderRequest: Promise<void> | undefined;
  let historyVersion = 0;
  let stop = connect();

  function remember(next: bots.BotConversation) {
    snapshot = next;
    botCache.set(create(bots.BotCachedViewSchema, { key, conversation: next }));
  }

  function reconnect() {
    live = false;
    stop();
    stop = connect();
  }

  function resetCheckpoint() {
    historyVersion++;

    if (snapshot) snapshot = { ...snapshot, cursor: "" };
    botCache.delete(key);
    reconnect();
  }

  function connect() {
    return liveSource(`${url}/events`, {
      url: () => `${url}/events?incremental=1&cursor=${encodeURIComponent(snapshot?.cursor ?? "")}`,
      ondrop: () => (live = false),
      onmessage: (json) => {
        let next: bots.BotConversation;

        try {
          const update = decode(bots.BotConversationSchema, JSON.parse(json));
          next = applyBotConversation(snapshot, update);

          if (!update.delta) historyVersion++;

          if (update.bot) botList.upsert(update.bot, "conversation");
        } catch {
          resetCheckpoint();

          return;
        }

        remember(next);
        live = true;
      },
    });
  }

  function loadOlder() {
    if (olderRequest) return olderRequest;
    const base = snapshot;

    if (!base?.historyHasMore || !base.cursor) return Promise.resolve();
    loadingOlder = true;
    historyError = "";
    olderRequest = readOlder(base, historyVersion).finally(() => {
      olderRequest = undefined;
      loadingOlder = false;
    });

    return olderRequest;
  }

  async function readOlder(base: bots.BotConversation, version: number) {
    try {
      const query = new URLSearchParams({ before: String(base.historyBeforeSeq), cursor: base.cursor });
      const response = await fetch(`${url}/history?${query}`, { signal: abort.signal });

      if (!response.ok) throw new Error("History unavailable");
      const page = decode(bots.BotConversationSchema, await bodyJson(response));

      if (abort.signal.aborted || !snapshot || version !== historyVersion) return;

      if (page.historyReset) resetCheckpoint();
      else {
        // Replay changes that arrived while the page was loading against the wider in-memory window.
        remember(prependBotPage(snapshot, page, base.cursor));
        reconnect();
      }
    } catch {
      if (!abort.signal.aborted) historyError = "Could not load earlier messages.";
    }
  }

  return {
    id,
    get snapshot() {
      return snapshot;
    },
    get historyError() {
      return historyError;
    },
    loadOlder,
    get loadingOlder() {
      return loadingOlder;
    },
    get live() {
      return live;
    },
    close() {
      stop();
      abort.abort();
    },
  };
}
