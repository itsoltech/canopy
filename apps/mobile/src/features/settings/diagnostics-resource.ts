import { useEffect } from "react";
import { AppState } from "react-native";
import type { QueryCache } from "@canopy/domain/shared-query";
import { useSession } from "../../state/session";
import { useSettingsResource, type SettingsApi } from "./resource";
import { useAppActive } from "../../ui/active";
import { whileForeground } from "../../state/foreground-work";

export { diagnosticsEpochs } from "./diagnostics-epochs";

const polling = new WeakMap<QueryCache, Map<string, { users: number; stop(): void }>>();

/** Screens share both the query and its foreground-only timer. */
export function useDiagnosticsResource<T>(key: string, fetch: (api: SettingsApi) => Promise<T>, enabled = true) {
  const resource = useSettingsResource(key, fetch, enabled);
  const { queries, epoch } = useSession();
  const active = useAppActive();
  const interval = resource.error ? 30_000 : 10_000;

  useEffect(() => {
    if (!active || !enabled) return;
    const entries = polling.get(queries) ?? new Map<string, { users: number; stop(): void }>();
    polling.set(queries, entries);
    const current = entries.get(key);

    if (current) current.users++;
    else {
      queries.invalidate(key);

      const stop = whileForeground(AppState, () => {
        const timer = setInterval(() => queries.invalidate(key), interval);

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
  }, [queries, key, active, epoch, interval, enabled]);

  return { ...resource, error: resource.error ? "Could not refresh diagnostics. Retry to get the latest data." : "" };
}
