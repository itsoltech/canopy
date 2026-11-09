import { createContext, useContext, useEffect, useEffectEvent, useMemo, useRef, type ReactNode } from "react";
import type { ui } from "@canopy/contracts";
import { useSession } from "./session";
import { useStream } from "./stream";
import { invalidateQueries } from "./queries";

type Listener = (update: ui.OverviewUpdate) => void;

/**
 * The pairing's only `WatchOverview` subscription. Overview, settings and shared reads all listen here,
 * so one phone opens one stream (and one remote subscription per linked computer at the gateway).
 */
function useOverviewBusState() {
  const { client, session, queries } = useSession();
  const listeners = useRef(new Set<Listener>());
  const snapshots = useRef(0);

  const stream = useStream(
    client ? (signal) => client.api.watchOverview({ includeSnapshot: true }, { signal }) : null,
    (update: ui.OverviewUpdate) => {
      const resubscribed = update.change.case === "mobileSnapshot" && snapshots.current++ > 0;

      for (const listener of listeners.current) listener(update);
      invalidateQueries(queries, update, resubscribed);
    },
    `overview:${session?.deviceId}`,
  );

  const subscribe = useMemo(
    () => (listener: Listener) => {
      listeners.current.add(listener);

      return () => {
        listeners.current.delete(listener);
      };
    },
    [],
  );

  return { stream, subscribe };
}

const Context = createContext<ReturnType<typeof useOverviewBusState> | null>(null);

export function OverviewBusProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();

  return <OverviewBusSession key={session?.deviceId ?? "unpaired"}>{children}</OverviewBusSession>;
}

function OverviewBusSession({ children }: { children: ReactNode }) {
  return <Context.Provider value={useOverviewBusState()}>{children}</Context.Provider>;
}

function useOverviewBus() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing OverviewBusProvider");

  return value;
}

/** The connection of the shared overview stream. */
export const useOverviewStream = () => useOverviewBus().stream;

/** Receives every overview update while mounted. Children subscribe before the stream starts. */
export function useOverviewEvents(listener: Listener) {
  const { subscribe } = useOverviewBus();
  const receive = useEffectEvent(listener);

  useEffect(() => subscribe((update) => receive(update)), [subscribe]);
}
