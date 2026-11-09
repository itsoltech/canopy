import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ui } from "@canopy/contracts";
import type { QueryCache, QueryFetch } from "@canopy/domain/shared-query";
import { useSession } from "./session";

/** Every overview update after the first snapshot that a shared read depends on (by key prefix). */
const INVALIDATES: Partial<Record<NonNullable<ui.OverviewUpdate["change"]["case"]>, readonly string[]>> = {};

/**
 * Applies one overview update to the pairing's shared reads. A snapshot after a resubscription means the stream
 * had a gap: every entry reads again once (watched ones now, the rest on next use).
 */
export function invalidateQueries(queries: QueryCache, update: ui.OverviewUpdate, resubscribed = false) {
  const change = update.change;

  if (change.case === "mobileSnapshot") {
    if (resubscribed) queries.invalidate(() => true);

    return;
  }

  if (change.case === "linkedReadCompleted") {
    queries.invalidate((key) => key === change.value || key.startsWith(`${change.value}:`));

    return;
  }

  const prefixes = change.case ? INVALIDATES[change.case] : undefined;

  if (prefixes) queries.invalidate((key) => prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`)));
}

/** A read shared by every screen of the pairing, kept current by overview events. */
export function useSharedQuery<T>(key: string, fetch: QueryFetch<T>, enabled = true) {
  const { queries } = useSession();
  const fetchRef = useRef(fetch);

  useEffect(() => {
    fetchRef.current = fetch;
  }, [fetch]);

  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? queries.watch<T>(key, (signal) => fetchRef.current(signal), listener) : () => {},
    [queries, key, enabled],
  );

  const snapshot = useSyncExternalStore(subscribe, () => queries.snapshot<T>(key));

  return {
    ...snapshot,
    /** Reads again now (Retry); joins a read already running. */
    reload: async () => {
      queries.invalidate(key);
      await queries.read<T>(key, fetchRef.current);
    },
  };
}
