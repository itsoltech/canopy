import { create } from "@bufbuild/protobuf";
import { ItemDeltaSchema, ThreadEventSchema, ui, type ItemDelta } from "@canopy/contracts";

/** How long a partial line of deltas may wait for more before it goes out (ms). */
export const DELTA_WINDOW_MS = 200;

/**
 * Text deltas of one thread stream, merged before they reach the browser: harnesses send a delta per
 * token (Codex: ~4 characters, Claude: ~17), the UI shows whole lines. Consecutive `item_delta`
 * events of the same item and field become one event whose chunk is their concatenation, sent when
 * a chunk brings a line break, after `windowMs`, before any other update and when the stream ends.
 *
 * Order is kept (nothing overtakes a held delta) and the reducer's result is the same as applying the
 * deltas one by one, since it appends chunks in order. A merged event carries the last delta's `seq`,
 * ids and time, and no `raw_json` (the provider's payload of a single delta; the UI never reads it).
 * After a reconnect the stream starts with a fresh snapshot, so a held delta of the old stream that
 * never went out is not missed.
 */
export async function* coalesceDeltas(
  source: AsyncIterable<ui.ThreadUpdate>,
  { windowMs = DELTA_WINDOW_MS }: { windowMs?: number } = {},
): AsyncGenerator<ui.ThreadUpdate> {
  const iterator = source[Symbol.asyncIterator]();
  let held: { update: ui.ThreadUpdate; chunks: string[]; merged: boolean; deadline: number } | undefined;
  const release = (): ui.ThreadUpdate | undefined => {
    if (!held) return undefined;
    const { update, chunks, merged } = held;
    held = undefined;
    return merged ? withChunk(update, chunks.join("")) : update;
  };
  try {
    let next = iterator.next();
    for (;;) {
      const result = held ? await raceDeadline(next, held.deadline) : await next;
      if (result === TIMEOUT) {
        yield release()!;
        continue;
      }
      if (result.done) break;
      next = iterator.next();
      const update = result.value;
      const delta = deltaOf(update);
      if (delta && held && sameTarget(deltaOf(held.update)!, delta)) {
        held.update = update;
        held.chunks.push(delta.chunk);
        held.merged = true;
      } else {
        const out = release();
        if (out) yield out;
        if (!delta) {
          yield update;
          continue;
        }
        held = { update, chunks: [delta.chunk], merged: false, deadline: Date.now() + windowMs };
      }
      if (delta.chunk.includes("\n")) yield release()!;
    }
    const out = release();
    if (out) yield out;
  } finally {
    await iterator.return?.();
  }
}

const TIMEOUT = Symbol("timeout");

async function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function deltaOf(update: ui.ThreadUpdate): ItemDelta | undefined {
  const change = update.change;
  if (change.case !== "event") return undefined;
  const body = change.value.event?.body;
  return body?.case === "itemDelta" ? body.value : undefined;
}

const sameTarget = (a: ItemDelta, b: ItemDelta) => a.itemId === b.itemId && a.field === b.field;

/** The last delta of a run, with the run's text as its chunk. */
function withChunk(last: ui.ThreadUpdate, chunk: string): ui.ThreadUpdate {
  const change = last.change;
  const delta = deltaOf(last);
  if (change.case !== "event" || !change.value.event || !delta) return last;
  const body = create(ItemDeltaSchema, { itemId: delta.itemId, field: delta.field, chunk });
  const event = create(ThreadEventSchema, { ...change.value.event, rawJson: "", body: { case: "itemDelta", value: body } });
  return create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: change.value.seq, event } } });
}
