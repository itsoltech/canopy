import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { eventItemId, reduceItem } from "./items.ts";
import { applyThreadDelta } from "./thread-mirror.ts";

const upsert = <T>(rows: T[], value: T, key: (row: T) => string) => [
  ...rows.filter((row) => key(row) !== key(value)),
  value,
];

/** Keep the last atomic checkpoint during live events; reopening replays projected upserts since it. */
export function applyThreadUpdate(state: ui.ThreadSnapshot | undefined, update: ui.ThreadUpdate): ui.ThreadSnapshot {
  const change = update.change;

  if (change.case === "snapshot") return change.value;

  if (change.case === "delta") {
    if (!state?.cursor || state.cursor !== change.value.baseCursor) throw new Error("Thread checkpoint mismatch");

    return applyThreadDelta(state, change.value);
  }

  const previous = state ?? create(ui.ThreadSnapshotSchema);

  switch (change.case) {
    case "thread":
      return { ...previous, thread: change.value };
    case "turn":
      return {
        ...previous,
        turns: upsert(previous.turns, change.value, (t) => `${t.fromThreadId}:${t.id}`).sort(
          (a, b) => a.ordinal - b.ordinal,
        ),
      };
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
  const index = previous.items.findIndex((i) => i.item?.itemId === id && !i.inherited);
  const old = previous.items[index];
  const item = id ? reduceItem(old?.item, body) : undefined;

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

  if (index < 0) items.push(entry);
  else items[index] = entry;

  return { ...previous, items, lastSeq: seq };
}
