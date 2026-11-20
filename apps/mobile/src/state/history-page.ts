import { useEffect, useRef, useState } from "react";
import type { bots } from "@canopy/contracts";
import { prependBotPage } from "@canopy/domain/history-pages";

interface PageSource<T> {
  current: { current: T | undefined };
  read: (base: T, signal: AbortSignal) => Promise<T>;
}

export function useHistoryPage<T extends { historyHasMore: boolean; historyItemsHasMore?: boolean }>(
  key: string,
  options: PageSource<T> & { apply: (base: T, current: T, page: T) => void },
) {
  const request = useRef<AbortController | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), [key]);

  return {
    loading,
    error,
    async load() {
      const base = options.current.current;

      if ((!base?.historyHasMore && !base?.historyItemsHasMore) || !base || request.current) return;
      const abort = new AbortController();
      request.current = abort;
      setLoading(true);
      setError("");

      try {
        const page = await options.read(base, abort.signal);
        const current = options.current.current;

        if (abort.signal.aborted || !current) return;
        options.apply(base, current, page);
      } catch {
        if (!abort.signal.aborted) setError("Could not load earlier messages. Try again.");
      } finally {
        request.current = undefined;

        if (!abort.signal.aborted) setLoading(false);
      }
    },
  };
}

/** Bot watches replay edits outside the old window from the pre-read checkpoint. */
export function useBotHistoryPage<T extends bots.BotConversation | bots.ReadBotExchangeResponse>(
  key: string,
  options: PageSource<T> & { receive: (value: T) => void; restart: () => void },
) {
  return useHistoryPage(key, {
    ...options,
    apply(base, current, page) {
      let next: T;

      try {
        next = prependBotPage(current, page, base.cursor);
      } catch {
        next = { ...current, cursor: "" };
      }

      options.receive(next);
      options.restart();
    },
  });
}

/** Stops the auxiliary stream as soon as its first state arrives. */
export async function firstHistoryPage<T>(
  watch: (signal: AbortSignal) => AsyncIterable<T>,
  signal: AbortSignal,
): Promise<T> {
  const abort = new AbortController();

  try {
    for await (const value of watch(AbortSignal.any([signal, abort.signal]))) return value;
    throw new Error("History unavailable");
  } finally {
    abort.abort();
  }
}
