import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { eventItemId, reduceItem } from "./items.ts";
import { applyThreadDelta } from "./thread-mirror.ts";
import { applyTurnEvent } from "./thread-turn-events.ts";
import { loadedThreadDelta, orderThreadTurns } from "./history-pages.ts";
import { applyThreadBatch } from "./thread-batch.ts";

const upsert = <T>(rows: T[], value: T, key: (row: T) => string) => [
  ...rows.filter((row) => key(row) !== key(value)),
  value,
];

const itemPositions = new WeakMap<ui.TimelineItem[], Map<string, number>>();

function ownItemPositions(items: ui.TimelineItem[]): Map<string, number> {
  const cached = itemPositions.get(items);

  if (cached) return cached;
  const positions = new Map<string, number>();

  items.forEach((entry, index) => {
    if (entry.item && !entry.inherited && !positions.has(entry.item.itemId)) positions.set(entry.item.itemId, index);
  });
  itemPositions.set(items, positions);

  return positions;
}

/** Keep the last atomic checkpoint during live events; reopening replays projected upserts since it. */
export function applyThreadUpdate(state: ui.ThreadSnapshot | undefined, update: ui.ThreadUpdate): ui.ThreadSnapshot {
  const change = update.change;

  if (change.case === "batch") {
    if (!state) throw new Error("Thread sequence base is missing");

    return applyThreadBatch(state, change.value);
  }

  if (change.case === "snapshot") {
    if (update.syncStatus?.reason === "computer_unreachable" && state && state.thread?.id === change.value.thread?.id)
      return { ...state, thread: change.value.thread };

    return change.value;
  }

  if (change.case === "delta") {
    if (!state?.cursor || state.cursor !== change.value.baseCursor) throw new Error("Thread checkpoint mismatch");

    return applyThreadDelta(state, change.value);
  }

  const previous = state ?? create(ui.ThreadSnapshotSchema);

  switch (change.case) {
    case "controls":
      return { ...previous, secrets: change.value.secrets, schedules: change.value.schedules };
    case "thread":
      return { ...previous, thread: change.value };
    case "turn":
      return loadedThreadDelta(previous, {
        ...previous,
        turns: orderThreadTurns(upsert(previous.turns, change.value, (t) => `${t.fromThreadId}:${t.id}`)),
      });
    case "interaction":
      return { ...previous, interactions: upsert(previous.interactions, change.value, (i) => i.requestId) };
    case "secret":
      return { ...previous, secrets: upsert(previous.secrets, change.value, (s) => s.requestId) };
    case "steer":
      return { ...previous, steers: upsert(previous.steers, change.value, (s) => s.id) };
    case "schedule":
      return { ...previous, schedules: upsert(previous.schedules, change.value, (s) => s.id) };
    case "goal":
      return { ...previous, goal: change.value };
    case "busDelivery":
      return { ...previous, busDeliveries: upsert(previous.busDeliveries, change.value, (d) => d.callId) };
    case "event":
      return applyEvent(previous, change.value);
    default:
      return previous;
  }
}

function applyEvent(previous: ui.ThreadSnapshot, change: ui.ThreadEventUpdate): ui.ThreadSnapshot {
  const { event, seq } = change;

  if (!event || seq <= previous.lastSeq) return previous;
  const body = event.body;

  if (body.case === "turnStarted" || body.case === "turnFinished")
    return { ...previous, lastSeq: seq, turns: applyTurnEvent(previous.turns, event) };

  if (body.case === "notice")
    return {
      ...previous,
      lastSeq: seq,
      notices: [
        ...previous.notices.slice(-199),
        create(ui.ThreadNoticeSchema, { seq, turnId: event.turnId, notice: body.value, occurredAt: event.occurredAt }),
      ],
    };

  const id = eventItemId(body);

  if (!id) return { ...previous, lastSeq: seq };
  const positions = ownItemPositions(previous.items);
  const index = positions.get(id) ?? -1;
  const old = previous.items[index];
  const item = reduceItem(old?.item, body);

  if (!item) return { ...previous, lastSeq: seq };

  const completedAt =
    body.case === "itemCompleted" && item.content.case === "agentMessage" ? event.occurredAt : old?.completedAt;

  const entry = create(ui.TimelineItemSchema, {
    item,
    turnId: old?.turnId || event.turnId,
    firstSeq: old?.firstSeq ?? seq,
    lastSeq: seq,
    ...(completedAt && { completedAt }),
  });

  const items = [...previous.items];

  // Transfer ownership before extending the index. Replaying an older snapshot (or
  // branching from it) rebuilds its own map instead of seeing a later append.
  itemPositions.delete(previous.items);

  if (index < 0) {
    positions.set(id, items.length);
    items.push(entry);
  } else items[index] = entry;
  itemPositions.set(items, positions);

  return { ...previous, items, lastSeq: seq };
}
