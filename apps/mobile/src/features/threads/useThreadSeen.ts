import { useEffect, useRef } from "react";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import type { ThreadState } from "./ThreadScreen";

const SEEN_AFTER_MS = 1000;

/** Only the visible, positioned end of a live conversation acknowledges its latest loaded result. */
export function useThreadSeen(state: ThreadState, positioned: boolean) {
  const { client } = useSession();
  const { threads } = useOverview();
  const active = useAppActive();
  const { id, snapshot, following, stream, home } = state;
  const thread = threads.find((thread) => thread.id === id) ?? snapshot?.thread;
  const markedUnread = thread?.markedUnread;
  const unseen = Boolean(thread?.unseenResult || markedUnread);
  const lastSeq = snapshot?.lastSeq ?? 0n;
  const atBottom = following.atBottom;
  const live = stream.connection === "live" && !home.away;
  const previous = useRef({ id, markedUnread, preserve: false });

  useEffect(() => {
    const before = previous.current;

    // Keep a manual "Mark as unread" made while this thread is open, as on web.
    if (before.id !== id) before.preserve = false;
    else if (markedUnread && before.markedUnread === false) before.preserve = true;

    if (!markedUnread) before.preserve = false;
    before.id = id;
    before.markedUnread = markedUnread;

    if (!client || !active || !live || !positioned || !atBottom || !unseen || before.preserve) return;

    const timer = setTimeout(() => {
      void client.api.markThreadSeen({ threadId: id, upToSeq: lastSeq }).catch(() => {});
    }, SEEN_AFTER_MS);

    return () => clearTimeout(timer);
  }, [client, id, active, live, positioned, atBottom, unseen, markedUnread, lastSeq]);
}
