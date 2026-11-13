import { useEffect } from "react";
import { AppState } from "react-native";
import type { QueryCache } from "@canopy/domain/shared-query";
import { useSession } from "./session";
import { whileForeground } from "./foreground-work";
import { useAppActive } from "../ui/active";

const refreshing = new WeakMap<QueryCache, Map<string, { users: number; stop: () => void }>>();

/** A module and its summary share one foreground fallback timer for the same read. */
export function useQueryRefresh(key: string, everyMs: number, enabled: boolean) {
  const { queries } = useSession();
  const active = useAppActive();

  useEffect(() => {
    if (!active || !enabled) return;
    let entries = refreshing.get(queries);

    if (!entries) {
      entries = new Map();
      refreshing.set(queries, entries);
    }

    const current = entries.get(key);

    if (current) current.users++;
    else {
      const stop = whileForeground(AppState, () => {
        const timer = setInterval(() => queries.invalidate(key), everyMs);

        return () => clearInterval(timer);
      });

      entries.set(key, { users: 1, stop });
    }

    return () => {
      const entry = entries.get(key);

      if (!entry || --entry.users) return;
      entry.stop();
      entries.delete(key);
    };
  }, [queries, key, everyMs, enabled, active]);
}
