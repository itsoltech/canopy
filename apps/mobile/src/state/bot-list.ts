import { useEffect, useRef } from "react";
import { useSession } from "./session";
import { useSharedQuery } from "./queries";

/** The pairing's one bot list, archived bots included: sidebar, alerts, settings and mentions share it. */
export const BOT_LIST = "ListBots:archived";

/** How often the shared list reads again while the gateway does not push bot changes. */
const BOT_LIST_FALLBACK_MS = 10_000;

export function useBotList() {
  const { client } = useSession();

  return useSharedQuery(
    BOT_LIST,
    (signal) => client!.api.listBots({ includeArchived: true }, { signal }),
    Boolean(client),
  );
}

/**
 * Keeps the shared list current: one read on mount, again after the app returns to the foreground or the
 * network changes, and one fallback poll in the foreground. A slow read is never overlapped.
 */
export function useBotListSync() {
  const { client, active, online, epoch, queries, updateBots } = useSession();
  const list = useBotList();
  const started = useRef(false);

  useEffect(() => {
    if (list.data) updateBots(list.data.bots);
  }, [list.data, updateBots]);

  useEffect(() => {
    if (!client || !active || !online) return;

    if (started.current) queries.invalidate(BOT_LIST);
    started.current = true;
    const timer = setInterval(() => queries.invalidate(BOT_LIST), BOT_LIST_FALLBACK_MS);

    return () => clearInterval(timer);
  }, [client, active, online, epoch, queries]);
}

/** Reads the shared list again now, e.g. after a bot action; joins a read already running. */
export function useRefreshBots() {
  const { client, queries } = useSession();

  return async () => {
    if (!client) return;
    queries.invalidate(BOT_LIST);
    await queries.read(BOT_LIST, (signal) => client.api.listBots({ includeArchived: true }, { signal }));
  };
}
