import { useCallback, useEffect, useRef } from "react";
import type { ui } from "@canopy/contracts";
import type { PersistentArchivedCache } from "../storage/archived-cache";

/** How long a lifecycle response waits for its stream echo before it applies itself. */
const echoWait = 2000;

const archivedOf = (thread: ui.Thread) => Boolean(thread.archivedAt) || thread.status === "archived";

/**
 * Archive and unarchive responses carry the thread as the gateway saved it. The overview stream normally echoes it
 * first. When it is down, or the echo is lost, the response applies itself (immediately when the stream is not
 * live, else after `echoWait`), so a swiped row never stays an empty slot. It goes through the same path as a
 * stream event; an echo that arrives later finds the same row in the same place and moves nothing. A response
 * whose archive state the list already shows is dropped: the echo, or something newer, got there first.
 */
export function useSettleThread(
  threads: readonly ui.Thread[],
  live: boolean,
  archivedCache: PersistentArchivedCache | null | undefined,
  apply: (thread: ui.Thread) => void,
) {
  const latest = useRef(threads);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const liveNow = useRef(live);

  useEffect(() => {
    latest.current = threads;
    liveNow.current = live;
  }, [threads, live]);

  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return useCallback(
    (thread: ui.Thread) => {
      const settle = () => {
        const known = latest.current.find((row) => row.id === thread.id);

        if (known && archivedOf(known) === archivedOf(thread)) return;
        void archivedCache?.reconcile(thread)?.catch(() => {});
        apply(thread);
      };

      if (!liveNow.current) return settle();

      const timer = setTimeout(() => {
        timers.current.delete(timer);
        settle();
      }, echoWait);

      timers.current.add(timer);
    },
    [archivedCache, apply],
  );
}
