import type { ui } from "@canopy/contracts";

/**
 * Reports the visible end of a thread seen through the BFF. A newer result can be reported as soon as
 * it is shown, including after the reader scrolls back down to it.
 */
export function trackSeen(
  read: () => { threadId: string; thread?: ui.Thread; rendered?: ui.Thread; showsLatest: boolean },
): void {
  let lastId: string | undefined;
  let reportedSeq: bigint | undefined;
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
    const { threadId, thread, rendered, showsLatest } = read();
    const markedUnread = thread?.markedUnread ?? false;

    if (threadId !== lastId) {
      preserve = false;
      reportedSeq = undefined;
    } else if (markedUnread && !wasMarked) preserve = true;

    if (!markedUnread) preserve = false;
    lastId = threadId;
    wasMarked = markedUnread;

    if (preserve || !visible || !showsLatest || !thread || !(thread.unseenResult || markedUnread)) {
      reportedSeq = undefined;

      return;
    }

    const lastSeq = thread.lastSeq;

    if (rendered?.id !== threadId || rendered.lastSeq < lastSeq) return;

    if (lastSeq === reportedSeq) return;
    reportedSeq = lastSeq;

    void fetch(`/api/threads/${threadId}/seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upToSeq: lastSeq.toString() }),
    }).catch(() => {});
  });
}
