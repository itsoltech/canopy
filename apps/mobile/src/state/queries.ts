import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { QueryFetch } from "@canopy/domain/shared-query";
import { useSession } from "./session";

/**
 * A read shared by every screen of the pairing, kept current by overview events (`state/overview-bus.tsx`).
 * `maxAgeMs` bounds data with changes that send no event: a screen opened later reads an older value again.
 */
export function useSharedQuery<T>(key: string, fetch: QueryFetch<T>, enabled = true, maxAgeMs = Infinity) {
  const { queries } = useSession();
  const fetchRef = useRef(fetch);

  useEffect(() => {
    fetchRef.current = fetch;
  }, [fetch]);

  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? queries.watch<T>(key, (signal) => fetchRef.current(signal), listener, maxAgeMs) : () => {},
    [queries, key, enabled, maxAgeMs],
  );

  const snapshot = useSyncExternalStore(subscribe, () => queries.snapshot<T>(key));

  return {
    ...snapshot,
    /** Reads again now (Retry, after a mutation); joins a read already running. */
    reload: async () => {
      queries.invalidate(key);
      await queries.read<T>(key, fetchRef.current);
    },
  };
}
