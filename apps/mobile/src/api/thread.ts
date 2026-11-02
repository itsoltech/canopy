import { create } from '@bufbuild/protobuf';
import { ui } from '@open-agents/contracts';
import { eventItemId, reduceItem } from '@open-agents/domain/items';

const upsert = <T,>(rows: T[], value: T, key: (row: T) => string) => [...rows.filter((r) => key(r) !== key(value)), value];
/** The server sends a fresh snapshot on reconnect, then ordered events. Never accumulate replayed deltas. */
export function applyThread(state: ui.ThreadSnapshot | undefined, update: ui.ThreadUpdate): ui.ThreadSnapshot {
  const change = update.change;
  if (change.case === 'snapshot') return change.value;
  const previous = state ?? create(ui.ThreadSnapshotSchema);
  switch (change.case) {
    case 'thread': return { ...previous, thread: change.value };
    case 'turn': return { ...previous, turns: upsert(previous.turns, change.value, (t) => `${t.fromThreadId}:${t.id}`).sort((a, b) => a.ordinal - b.ordinal) };
    case 'interaction': return { ...previous, interactions: upsert(previous.interactions, change.value, (i) => i.requestId) };
    case 'steer': return { ...previous, steers: upsert(previous.steers, change.value, (s) => s.id) };
    case 'event': {
      const { event, seq } = change.value;
      if (!event || seq <= previous.lastSeq) return previous;
      const body = event.body;
      if (body.case === 'notice') return { ...previous, lastSeq: seq, notices: [...previous.notices.slice(-199), create(ui.ThreadNoticeSchema, { seq, turnId: event.turnId, notice: body.value })] };
      const id = eventItemId(body);
      const index = previous.items.findIndex((i) => i.item?.itemId === id && !i.inherited);
      const old = previous.items[index];
      const item = id ? reduceItem(old?.item, body) : undefined;
      if (!item) return { ...previous, lastSeq: seq };
      const entry = create(ui.TimelineItemSchema, { item, turnId: old?.turnId || event.turnId, firstSeq: old?.firstSeq ?? seq, lastSeq: seq });
      const items = [...previous.items];
      if (index < 0) items.push(entry); else items[index] = entry;
      return { ...previous, items, lastSeq: seq };
    }
    default: return previous;
  }
}

export function threadStatus(thread: ui.Thread): { label: string; tone: 'active' | 'attention' | 'muted' } {
  if (thread.pendingInteractions || thread.status === 'waiting_input') return { label: 'Needs input', tone: 'attention' };
  if (['creating', 'running'].includes(thread.status)) return { label: 'Running', tone: 'active' };
  if (thread.status === 'failed') return { label: 'Failed', tone: 'attention' };
  return { label: thread.status === 'interrupted' ? 'Interrupted' : 'Idle', tone: 'muted' };
}
