/** How long the latest result stays on screen before it counts as seen. */
const SEEN_AFTER_MS = 1_000;

/**
 * Reports a thread seen (MarkThreadSeen through the BFF) once its unseen result has been on screen: the tab
 * visible and the timeline following its end for a moment. Again whenever a newer result arrives while that
 * holds, or once the reader scrolls back down to it. Call from a component's script (it sets up effects).
 */
export function trackSeen(read: () => { threadId: string; unseen: boolean; markedUnread?: boolean; lastSeq: bigint; atEnd: boolean }): void {
  let lastId: string | undefined;
  let wasMarked = false;
  let preserve = false;
  let visible = $state(typeof document !== "undefined" && document.visibilityState === "visible");
  $effect(() => {
    const sync = () => (visible = document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  });
  $effect(() => {
    const { threadId, unseen, lastSeq, atEnd, markedUnread = false } = read();
    if (threadId !== lastId) preserve = false;
    else if (markedUnread && !wasMarked) preserve = true;
    if (!markedUnread) preserve = false;
    lastId = threadId;
    wasMarked = markedUnread;
    if (preserve) return;
    if (!unseen || !atEnd || !visible) return;
    const timer = setTimeout(() => {
      void fetch(`/api/threads/${threadId}/seen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upToSeq: lastSeq.toString() }),
      }).catch(() => {});
    }, SEEN_AFTER_MS);
    return () => clearTimeout(timer);
  });
}
