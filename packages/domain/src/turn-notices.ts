import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import { NoticeLevel, type Item, type Notice, type ui } from "@canopy/contracts";

interface NoticeEntry {
  readonly seq: bigint;
  readonly turnId: string;
  readonly notice?: Notice | undefined;
  readonly at?: Timestamp | undefined;
  readonly occurredAt?: Timestamp | undefined;
}

interface ItemEntry {
  readonly turnId: string;
  readonly firstSeq: bigint;
  readonly item?: Item | undefined;
}

export interface NoticeState {
  readonly count?: number;
  /** A diagnostic in a turn that completed successfully, regardless of willRetry. */
  readonly recovered?: boolean;
}

/** Memoization preserves feed row identity; association, severity and counts use only durable data. */
const cache = new WeakMap<NoticeEntry, { key: string; value: NoticeEntry & NoticeState }>();

/**
 * Repair older unlinked diagnostics only with a unique stored time/sequence interval. An explicit link
 * (including a turn outside the loaded history window) always wins. Repeats keep their first position,
 * within the same work segment; the raw notices remain untouched for sync, details and diagnostics.
 */
export function turnNotices<N extends NoticeEntry>(
  notices: readonly N[],
  turns: readonly ui.Turn[],
  items: readonly ItemEntry[],
): readonly (N & NoticeState)[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const bounds = new Map<string, { first: bigint; last: bigint }>();
  const barriers = new Map<string, bigint[]>();

  for (const entry of items) {
    if (!entry.turnId) continue;
    const previous = bounds.get(entry.turnId);
    bounds.set(entry.turnId, {
      first: previous && previous.first < entry.firstSeq ? previous.first : entry.firstSeq,
      last: previous && previous.last > entry.firstSeq ? previous.last : entry.firstSeq,
    });
    const content = entry.item?.content;

    if (
      content?.case === "userMessage" ||
      (content?.case === "agentMessage" && content.value.phase === "final_answer")
    ) {
      const list = barriers.get(entry.turnId) ?? [];
      list.push(entry.firstSeq);
      barriers.set(entry.turnId, list);
    }
  }

  const grouped = new Map<string, { source: N; turnId: string; count: number; recovered: boolean }>();

  for (const entry of [...notices].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))) {
    if (!entry.notice) continue;
    const turnId = entry.turnId || inferTurn(entry, turns, bounds);
    const turn = byId.get(turnId);
    const recovered = turn?.status === "completed" && entry.notice.level >= NoticeLevel.WARNING;
    const segment = (barriers.get(turnId) ?? []).filter((seq) => seq < entry.seq).length;

    const key = JSON.stringify([
      turnId || String(entry.seq),
      segment,
      entry.notice.level,
      entry.notice.code,
      entry.notice.message,
      entry.notice.dataJson,
    ]);

    const previous = grouped.get(key);

    if (previous) previous.count++;
    else grouped.set(key, { source: entry, turnId, count: 1, recovered });
  }

  return [...grouped.values()].map(({ source, turnId, count, recovered }) => {
    const key = `${turnId}/${count}/${recovered}`;
    const previous = cache.get(source);

    if (previous?.key === key) {
      // SAFETY: each cached value spreads this exact source object and adds only NoticeState and turnId.
      return previous.value as N & NoticeState;
    }

    const value = { ...source, turnId, count, recovered };
    cache.set(source, { key, value });

    return value;
  });
}

function inferTurn(
  entry: NoticeEntry,
  turns: readonly ui.Turn[],
  bounds: ReadonlyMap<string, { first: bigint; last: bigint }>,
): string {
  const at = entry.at ?? entry.occurredAt;

  const candidates = turns.filter((turn) => {
    if (turn.withdrawn || turn.fromThreadId) return false;

    if (at && turn.startedAt) {
      const time = timestampMs(at);

      return time >= timestampMs(turn.startedAt) && (!turn.completedAt || time <= timestampMs(turn.completedAt));
    }

    const range = bounds.get(turn.id);

    return range !== undefined && entry.seq > range.first && entry.seq < range.last;
  });

  return candidates.length === 1 ? candidates[0]!.id : "";
}
