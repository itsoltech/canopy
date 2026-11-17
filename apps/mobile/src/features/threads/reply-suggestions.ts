import { ItemStatus, type ui } from "@canopy/contracts";
import { orderThreadTurns } from "@canopy/domain/history-pages";

/** Only the last completed top-level answer supplies a turn's reply group. */
export function turnReplySource(turn: ui.Turn, entries: readonly ui.TimelineItem[]) {
  if (turn.status !== "completed") return undefined;

  const entry = entries.findLast((row) => row.item?.content.case === "agentMessage" && !row.item.parentItemId);

  const item = entry?.item;

  return item?.content.case === "agentMessage" &&
    item.status === ItemStatus.COMPLETED &&
    (!item.content.value.phase || item.content.value.phase === "final_answer")
    ? item
    : undefined;
}

/** Queue entries count even while the timeline keeps them in the composer tray. */
export function activeReplySource(snapshot: ui.ThreadSnapshot | undefined) {
  const thread = snapshot?.thread;

  if (
    !snapshot ||
    !thread ||
    thread.status !== "idle" ||
    thread.archivedAt ||
    thread.worktree?.removedAt ||
    thread.deletedAt ||
    thread.rewindPending ||
    thread.import?.mode === "history"
  )
    return undefined;

  const turn = orderThreadTurns(
    snapshot.turns.filter((row) => !row.rewindId && !["consumed", "steered"].includes(row.withdrawn)),
  ).at(-1);

  if (!turn || turn.inherited || (turn.fromThreadId && turn.fromThreadId !== thread.id)) return undefined;
  const entries = snapshot.items.filter((row) => row.turnId === turn.id && !row.inherited);
  const item = turnReplySource(turn, entries);
  const entry = entries.find((row) => row.item === item);

  if (!item || !entry) return undefined;
  const turns = new Map(snapshot.turns.map((row) => [row.id, row]));

  if (
    snapshot.items.some(
      (row) =>
        !row.inherited &&
        !turns.get(row.turnId)?.rewindId &&
        row.item?.content.case === "userMessage" &&
        !row.item.parentItemId &&
        row.firstSeq > entry.firstSeq,
    )
  )
    return undefined;

  const completedAt = entry.completedAt ?? turn.completedAt;

  if (
    snapshot.steers.some((steer) => {
      if (turns.get(steer.turnId)?.rewindId) return false;

      const fallback = turns.get(steer.queuedTurnId);

      const resolved =
        fallback &&
        ["completed", "interrupted", "failed", "cancelled"].includes(fallback.status) &&
        !fallback.inherited &&
        !fallback.rewindId &&
        fallback.ordinal <= turn.ordinal;

      return (
        ["pending", "accepted"].includes(steer.status) ||
        (steer.status === "queued" && !resolved) ||
        (steer.createdAt &&
          completedAt &&
          (steer.createdAt.seconds > completedAt.seconds ||
            (steer.createdAt.seconds === completedAt.seconds && steer.createdAt.nanos >= completedAt.nanos)))
      );
    })
  )
    return undefined;

  return item.itemId;
}
