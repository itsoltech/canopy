import { useEffect, useRef, useState } from "react";
import type { Usage, ui } from "@canopy/contracts";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { useSession } from "./session";
import { useStream } from "./stream";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { firstHistoryPage, useHistoryPage } from "./history-page";

/** Read the durable base before subscribing; every retry uses the latest atomic checkpoint. */
export function useThreadSnapshot(id: string) {
  const { client, session, threadCache, active } = useSession();
  const [snapshot, setSnapshot] = useState(() => threadCache?.peek(id));
  const current = useRef(snapshot);
  const saving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [usage, setUsage] = useState<Usage>();
  useEffect(() => setUsage(undefined), [id, client]);
  useEffect(() => {
    let cancelled = false;
    void (threadCache?.load(id) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        current.current = cached ?? current.current;
        setSnapshot(current.current);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [id, threadCache]);

  const stream = useStream(
    client && loaded
      ? (signal) =>
          client.api.watchThread(
            {
              threadId: id,
              pageSize: 24,
              incremental: true,
              cursor: current.current?.cursor ?? "",
              fromTurnId: current.current?.historyBeforeTurnId ?? "",
              historyVersion: current.current?.historyVersion ?? "",
            },
            { signal },
          )
      : null,
    (update: ui.ThreadUpdate) => {
      if (update.change.case === "event" && update.change.value.event?.body.case === "usageUpdated")
        setUsage(update.change.value.event.body.value.usage);

      try {
        current.current = applyThreadUpdate(current.current, update);
      } catch {
        if (current.current) current.current = { ...current.current, cursor: "" };
        throw new Error("Thread resynchronization required");
      }

      setSnapshot(current.current);

      return !update.syncing;
    },
    `${session?.deviceId}:${id}`,
  );

  const history = useHistoryPage(id, {
    current,
    read: async (base, signal) => {
      if (!client) throw new Error("Gateway unavailable");

      const update = await firstHistoryPage(
        (signal) =>
          client.api.watchThread(
            { threadId: id, pageSize: 24, beforeTurnId: base.historyBeforeTurnId, historyVersion: base.historyVersion },
            { signal },
          ),
        signal,
      );

      if (update.change.case !== "snapshot") throw new Error("History unavailable");

      return update.change.value;
    },
    merge: prependThreadPage,
    receive: (next) => {
      current.current = next;
      setSnapshot(next);
    },
    restart: stream.retry,
  });

  useEffect(() => {
    if (!snapshot || !threadCache || saving.current) return;
    saving.current = setTimeout(() => {
      saving.current = undefined;

      if (current.current) void threadCache.save(current.current).catch(() => {});
    }, 2000);
  }, [snapshot, threadCache]);
  useEffect(() => {
    const save = () => {
      clearTimeout(saving.current);
      saving.current = undefined;

      if (current.current) void threadCache?.save(current.current).catch(() => {});
    };

    if (!active) save();

    return save;
  }, [active, threadCache]);

  return {
    snapshot,
    usage,
    history,
    stream,
    setSnapshot(update: (previous: ui.ThreadSnapshot | undefined) => ui.ThreadSnapshot | undefined) {
      current.current = update(current.current);
      setSnapshot(current.current);
    },
  };
}
