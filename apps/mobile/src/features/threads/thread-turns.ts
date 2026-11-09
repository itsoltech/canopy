import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dayKey } from "@canopy/domain/format";
import { orderThreadTurns } from "@canopy/domain/history-pages";

export function visibleTurns(snapshot: ui.ThreadSnapshot | undefined) {
  const turns = orderThreadTurns(snapshot?.turns.filter((t) => !t.withdrawn) ?? []);
  const known = new Set(turns.map((turn) => `${turn.fromThreadId}:${turn.id}`));
  const sequences = new Map<string, bigint>();

  for (const entry of snapshot?.items ?? []) {
    const key = `${entry.fromThreadId}:${entry.turnId}`;
    const previous = sequences.get(key);

    if (previous === undefined || entry.firstSeq < previous) sequences.set(key, entry.firstSeq);
  }

  // Provider-origin events can arrive before a turn update. Keep those entries visible.
  for (const item of snapshot?.items ?? []) {
    const key = `${item.fromThreadId}:${item.turnId}`;

    if (!known.has(key)) {
      known.add(key);

      const placeholder = create(ui.TurnSchema, {
        id: item.turnId,
        fromThreadId: item.fromThreadId,
        inherited: item.inherited,
        trigger: "provider",
      });

      // Persistent background items may precede the loaded page. Keep them before newer own turns.
      const before = turns.findIndex(
        (turn) =>
          !turn.inherited &&
          !item.inherited &&
          (sequences.get(`${turn.fromThreadId}:${turn.id}`) ?? snapshot?.lastSeq ?? 0n) > item.firstSeq,
      );

      turns.splice(before < 0 ? turns.length : before, 0, placeholder);
    }
  }

  return turns;
}

/** The new-day flag of each turn: it starts a calendar day the turns before it did not (web: buildTimeline). */
export function newDays(turns: readonly ui.Turn[]): ReadonlySet<ui.Turn> {
  const days = new Set<ui.Turn>();
  let last = "";

  for (const turn of turns) {
    const at = turn.startedAt ?? turn.queuedAt;

    if (!at) continue;
    const day = dayKey(at);

    if (day !== last) days.add(turn);
    last = day;
  }

  return days;
}
