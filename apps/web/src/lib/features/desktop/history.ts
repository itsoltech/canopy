import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { threadCacheTail } from "@canopy/domain/thread-cache-tail";

let generation = "";
let lifetime = 0;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; next?: () => void }>();

/** No bridge means memory-only browser use. Never persist conversation content in browser storage. */
export async function loadHistory<D extends DescMessage>(schema: D, key: string): Promise<MessageShape<D> | undefined> {
  const started = lifetime;

  try {
    const value = await window.canopyDesktop?.history?.read(key);

    if (!value || started !== lifetime) return undefined;
    generation = value.generation;

    return value.bytes ? fromBinary(schema, value.bytes, { readUnknownFields: false }) : undefined;
  } catch {
    return undefined;
  }
}

export function saveThreadHistory(snapshot: ui.ThreadSnapshot) {
  if (snapshot.thread && !snapshot.thread.deletedAt)
    saveHistory(`thread_${snapshot.thread.id}`, () => toBinary(ui.ThreadSnapshotSchema, threadCacheTail(snapshot)));
}

export function saveBotHistory(view: bots.BotCachedView) {
  saveHistory(view.key, () => toBinary(bots.BotCachedViewSchema, view));
}

function saveHistory(key: string, encode: () => Uint8Array) {
  if (!generation || !window.canopyDesktop?.history) return;
  const heldGeneration = generation;

  const write = () => {
    const timer = setTimeout(() => {
      const next = pending.get(key)?.next;
      pending.delete(key);
      next?.();
    }, 2000);

    pending.set(key, { timer });
    void window.canopyDesktop?.history?.write(heldGeneration, key, encode()).catch(() => {});
  };

  const held = pending.get(key);

  if (held) held.next = write;
  else write();
}

export function removeHistory(key: string) {
  const held = pending.get(key);

  if (held) clearTimeout(held.timer);
  pending.delete(key);
  void window.canopyDesktop?.history?.remove(key).catch(() => {});
}

export function reconcileBotHistory(ids: string[]) {
  if (generation) void window.canopyDesktop?.history?.reconcileBots?.(generation, ids).catch(() => {});
}

export function clearHistory() {
  lifetime++;
  generation = "";

  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  void window.canopyDesktop?.history?.clear().catch(() => {});
}
