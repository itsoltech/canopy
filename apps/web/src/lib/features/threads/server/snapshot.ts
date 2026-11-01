import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { gateway } from "#lib/server/gateway.ts";

/** Items the server renders from the end of a thread; the live snapshot brings the rest. */
const TAIL_ITEMS = 60;
const TIMEOUT_MS = 3000;

/**
 * The end of a thread for the server render, so the first paint shows the latest messages: the first
 * message of WatchThread (its snapshot), cut to the last items (whole turns from the first kept item
 * on; a fork's inherited items stay folded, so only its turns are kept). Undefined when the gateway
 * does not answer in time: the page then waits for the live stream as before.
 */
export async function tailSnapshot(threadId: string): Promise<ui.ThreadSnapshot | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    for await (const update of gateway().watchThread({ threadId }, { signal: abort.signal })) {
      return update.change.case === "snapshot" ? tail(update.change.value) : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

export function tail(snapshot: ui.ThreadSnapshot): ui.ThreadSnapshot {
  const own = snapshot.items.filter((i) => !i.inherited);
  if (own.length <= TAIL_ITEMS && own.length === snapshot.items.length) return snapshot;
  const kept = [...own].sort((a, b) => (a.firstSeq < b.firstSeq ? -1 : a.firstSeq > b.firstSeq ? 1 : 0)).slice(-TAIL_ITEMS);
  const fromSeq = kept[0]?.firstSeq ?? 0n;
  const ordinals = new Map(snapshot.turns.map((t) => [t.id, t.ordinal]));
  const keptOrdinals = kept.flatMap((i) => (ordinals.has(i.turnId) ? [ordinals.get(i.turnId)!] : []));
  // Turns from the first kept item's turn on (later turns may have no items yet); none of the earlier ones.
  const fromOrdinal = keptOrdinals.length > 0 ? Math.min(...keptOrdinals) : 0;
  return create(ui.ThreadSnapshotSchema, {
    ...snapshot,
    turns: snapshot.turns.filter((t) => t.inherited || t.ordinal >= fromOrdinal),
    items: kept,
    notices: snapshot.notices.filter((n) => n.seq >= fromSeq),
  });
}
