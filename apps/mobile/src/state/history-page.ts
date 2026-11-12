import { useEffect, useRef, useState } from "react";

/** Page reads keep the pre-read checkpoint. Reopening replays edits made outside the old loaded window. */
export function useHistoryPage<T extends { cursor: string; historyHasMore: boolean; historyItemsHasMore?: boolean }>(
  key: string,
  options: {
    current: { current: T | undefined };
    read: (base: T, signal: AbortSignal) => Promise<T>;
    merge: (current: T, page: T, checkpoint: string) => T;
    receive: (value: T) => void;
    restart: () => void;
  },
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
        let next: T;

        try {
          next = options.merge(current, page, base.cursor);
        } catch {
          next = { ...current, cursor: "" };
        }

        options.receive(next);
        options.restart();
      } catch {
        if (!abort.signal.aborted) setError("Could not load earlier messages. Try again.");
      } finally {
        request.current = undefined;

        if (!abort.signal.aborted) setLoading(false);
      }
    },
  };
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
