import { create } from "@bufbuild/protobuf";
import { ItemDeltaSchema, ThreadEventSchema, ui, type ItemDelta } from "@canopy/contracts";

/** How long a partial line of deltas may wait for more before it goes out (ms). */
export const DELTA_WINDOW_MS = 200;
const TIMEOUT = Symbol("timeout");
const batches = new WeakMap<ui.ThreadUpdate, { chunk: string; firstSeq: bigint; update: ui.ThreadUpdate }[]>();

/**
 * Text deltas of one thread stream, merged before they reach the browser: harnesses send a delta per
 * token (Codex: ~4 characters, Claude: ~17), the UI shows whole lines. Consecutive `item_delta`
 * events of the same item and field become one event whose chunk is their concatenation, sent when
 * a chunk brings a line break, after `windowMs`, before any other update and when the stream ends.
 *
 * Order is kept (nothing overtakes a held delta) and the reducer's result is the same as applying the
 * deltas one by one, since it appends chunks in order. A merged event carries the last delta's `seq`,
 * ids and time, and no `raw_json` (the provider's payload of a single delta; the UI never reads it).
 * A checkpoint resumes projected state after a reconnect. A held chunk never advances that checkpoint.
 * `sequenceRanges` adds the inclusive start for a negotiated linked watch; size and latency stay bounded.
 */
export async function* coalesceDeltas(
  source: AsyncIterable<ui.ThreadUpdate>,
  {
    windowMs = DELTA_WINDOW_MS,
    maxChars = 16 * 1024,
    sequenceRanges = false,
  }: { windowMs?: number; maxChars?: number; sequenceRanges?: boolean } = {},
): AsyncGenerator<ui.ThreadUpdate> {
  const iterator = source[Symbol.asyncIterator]();

  let held:
    | {
        update: ui.ThreadUpdate;
        chunks: string[];
        merged: boolean;
        timeout: Promise<typeof TIMEOUT>;
        timer: ReturnType<typeof setTimeout>;
        firstSeq: bigint;
        chars: number;
      }
    | undefined;

  const release = (): ui.ThreadUpdate | undefined => {
    if (!held) return undefined;
    const { update, chunks, merged, firstSeq } = held;
    clearTimeout(held.timer);
    held = undefined;

    return merged ? withChunk(update, chunks.join(""), sequenceRanges ? firstSeq : 0n) : update;
  };

  try {
    let next = iterator.next();
    void next.catch(() => {}); // Observe a prefetched rejection even while the downstream reader pauses.

    for (;;) {
      const result = held ? await Promise.race([next, held.timeout]) : await next;

      if (result === TIMEOUT) {
        yield release()!;
        continue;
      }

      if (result.done) break;
      next = iterator.next();
      void next.catch(() => {});
      const update = result.value;
      const delta = deltaOf(update);

      if (
        delta &&
        held &&
        sameTarget(deltaOf(held.update)!, delta) &&
        consecutive(held.update, update) &&
        held.chars + delta.chunk.length <= maxChars
      ) {
        held.update = update;
        held.chunks.push(delta.chunk);
        held.merged = true;
        held.chars += delta.chunk.length;
      } else {
        const out = release();

        if (out) yield out;

        if (!delta) {
          yield update;
          continue;
        }

        let timer!: ReturnType<typeof setTimeout>;

        const timeout = new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), windowMs);
        });

        held = {
          update,
          chunks: [delta.chunk],
          merged: false,
          timeout,
          timer,
          firstSeq: firstSequence(update),
          chars: delta.chunk.length,
        };
      }

      if (delta.chunk.includes("\n") || held.chars >= maxChars) yield release()!;
    }

    const out = release();

    if (out) yield out;
  } finally {
    if (held) clearTimeout(held.timer);
    await iterator.return?.();
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
function withChunk(last: ui.ThreadUpdate, chunk: string, firstSeq: bigint): ui.ThreadUpdate {
  const change = last.change;
  const delta = deltaOf(last);

  if (change.case !== "event" || !change.value.event || !delta) return last;
  // Fan-out readers often release the same range. Share the owned immutable batch, so a
  // transport may encode it once. Limit variants per weak key when readers have different windows.
  const variants = batches.get(last) ?? [];
  const existing = variants.find((batch) => batch.firstSeq === firstSeq && batch.chunk === chunk);

  if (existing) return existing.update;
  const body = create(ItemDeltaSchema, { itemId: delta.itemId, field: delta.field, chunk });

  const event = create(ThreadEventSchema, {
    ...change.value.event,
    rawJson: "",
    body: { case: "itemDelta", value: body },
  });

  const update = create(ui.ThreadUpdateSchema, {
    change: { case: "event", value: { seq: change.value.seq, firstSeq, event } },
  });

  if (variants.length < 4) {
    variants.push({ chunk, firstSeq, update });
    batches.set(last, variants);
  }

  return update;
}

function firstSequence(update: ui.ThreadUpdate) {
  return update.change.case === "event" ? update.change.value.firstSeq || update.change.value.seq : 0n;
}

function consecutive(previous: ui.ThreadUpdate, next: ui.ThreadUpdate) {
  if (previous.change.case !== "event" || next.change.case !== "event") return false;
  const a = previous.change.value;
  const b = next.change.value;

  return (
    a.seq + 1n === firstSequence(next) && a.event?.threadId === b.event?.threadId && a.event?.turnId === b.event?.turnId
  );
}
