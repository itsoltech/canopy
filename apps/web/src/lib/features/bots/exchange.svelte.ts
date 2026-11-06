import { untrack } from "svelte";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { applyBotExchange } from "@canopy/domain/bot-snapshot";
import { botViewKey } from "@canopy/domain/bot-cache";
import { bodyJson } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";
import { botCache } from "./cache.ts";
import { prependBotPage } from "@canopy/domain/history-pages";

/** Exchanges are read-only projections; refresh on open, focus and while visible, with the latest cursor. */
export function watchExchange(id: () => string) {
  let snapshot = $state.raw<bots.ReadBotExchangeResponse>();
  let syncing = $state(true);
  let error = $state("");
  let loadingOlder = $state(false);
  let loadOlder = async () => {};

  $effect(() => {
    const exchangeId = id();
    const key = botViewKey("exchange", exchangeId);
    snapshot = botCache.get(key)?.exchange;
    const abort = new AbortController();
    let fetching = false;

    const refresh = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      syncing = true;

      try {
        const read = async (cursor: string) => {
          const response = await fetch(
            `/api/bot-exchanges/${exchangeId}?incremental=1&cursor=${encodeURIComponent(cursor)}`,
            { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) },
          );

          if (!response.ok) throw new Error("Exchange unavailable");

          return bodyJson(response);
        };

        let next = decode(bots.ReadBotExchangeResponseSchema, await read(snapshot?.cursor ?? ""));

        try {
          next = applyBotExchange(snapshot, next);
        } catch {
          next = applyBotExchange(undefined, decode(bots.ReadBotExchangeResponseSchema, await read("")));
        }

        if (abort.signal.aborted) return;
        snapshot = next;
        botCache.set(create(bots.BotCachedViewSchema, { key, exchange: next }));
        syncing = false;
        error = "";
      } catch {
        if (!abort.signal.aborted) error = "Could not refresh this conversation. Reopen it to try again.";
      } finally {
        fetching = false;
      }
    };

    untrack(() => void refresh());
    loadOlder = async () => {
      if (!snapshot?.historyHasMore || fetching || loadingOlder) return;
      loadingOlder = true;
      fetching = true;
      const checkpoint = snapshot.cursor;

      try {
        const query = new URLSearchParams({
          incremental: "1",
          before: String(snapshot.historyBeforeSeq),
          cursor: checkpoint,
        });

        const response = await fetch(`/api/bot-exchanges/${exchangeId}?${query}`, { signal: abort.signal });

        if (!response.ok) throw new Error("History unavailable");
        const page = decode(bots.ReadBotExchangeResponseSchema, await bodyJson(response));

        if (abort.signal.aborted) return;

        try {
          snapshot = prependBotPage(snapshot, page, checkpoint);
        } catch {
          snapshot = { ...snapshot, cursor: "" };
        }

        botCache.set(create(bots.BotCachedViewSchema, { key, exchange: snapshot }));
      } catch {
        if (!abort.signal.aborted) error = "Could not load earlier messages. Try again.";
      } finally {
        fetching = false;
        loadingOlder = false;
      }

      await refresh();
    };

    const timer = setInterval(() => void refresh(), 5000);
    const resume = () => void refresh();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);

    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  });

  return {
    loadOlder: () => loadOlder(),
    get hasMore() {
      return snapshot?.historyHasMore ?? false;
    },
    get loadingOlder() {
      return loadingOlder;
    },
    get snapshot() {
      return snapshot;
    },
    get syncing() {
      return syncing;
    },
    get error() {
      return error;
    },
  };
}
