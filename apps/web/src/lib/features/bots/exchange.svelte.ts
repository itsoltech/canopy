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
  let watch = $state.raw<ReturnType<typeof openExchangeWatch>>();
  const active = $derived(watch?.id === id() ? watch : undefined);

  $effect(() => {
    const exchangeId = id();
    const current = untrack(() => openExchangeWatch(exchangeId));
    watch = current;

    return current.close;
  });

  return {
    loadOlder: async () => active?.loadOlder(),
    get loadingOlder() {
      return active?.loadingOlder ?? false;
    },
    get snapshot() {
      return active?.snapshot;
    },
    get syncing() {
      return active?.syncing ?? true;
    },
    get error() {
      return active?.error ?? "";
    },
    get historyError() {
      return active?.historyError ?? "";
    },
  };
}

function openExchangeWatch(id: string) {
  const key = botViewKey("exchange", id);
  const url = `/api/bot-exchanges/${id}`;
  const abort = new AbortController();
  let snapshot = $state.raw(botCache.get(key)?.exchange);
  let syncing = $state(true);
  let error = $state("");
  let historyError = $state("");
  let loadingOlder = $state(false);
  let refreshing = false;

  async function read(query: URLSearchParams) {
    const response = await fetch(`${url}?${query}`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
    });

    if (!response.ok) throw new Error("Exchange unavailable");

    return decode(bots.ReadBotExchangeResponseSchema, await bodyJson(response));
  }

  function remember(next: bots.ReadBotExchangeResponse) {
    snapshot = next;
    botCache.set(create(bots.BotCachedViewSchema, { key, exchange: next }));
  }

  async function refresh() {
    if (refreshing || loadingOlder || document.hidden) return;
    refreshing = true;
    syncing = true;

    try {
      const current = snapshot;
      const update = await read(new URLSearchParams({ incremental: "1", cursor: current?.cursor ?? "" }));
      let next: bots.ReadBotExchangeResponse;

      try {
        next = applyBotExchange(current, update);
      } catch {
        next = applyBotExchange(undefined, await read(new URLSearchParams({ incremental: "1" })));
      }

      if (abort.signal.aborted) return;
      remember(next);
      error = "";
    } catch {
      if (!abort.signal.aborted) error = "Could not refresh this conversation. Reopen it to try again.";
    } finally {
      refreshing = false;
      syncing = false;
    }
  }

  async function loadOlder() {
    const base = snapshot;

    if (!base?.historyHasMore || refreshing || loadingOlder) return;
    loadingOlder = true;
    historyError = "";

    try {
      const page = await read(
        new URLSearchParams({ incremental: "1", before: String(base.historyBeforeSeq), cursor: base.cursor }),
      );

      if (abort.signal.aborted) return;
      remember(page.historyReset ? applyBotExchange(undefined, page) : prependBotPage(base, page));
    } catch {
      if (!abort.signal.aborted) historyError = "Could not load earlier messages.";
    } finally {
      loadingOlder = false;
    }

    if (!abort.signal.aborted) await refresh();
  }

  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  const resume = () => void refresh();
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);

  return {
    id,
    loadOlder,
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
    get historyError() {
      return historyError;
    },
    close() {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    },
  };
}
