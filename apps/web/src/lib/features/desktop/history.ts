import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";

let generation = "";
let lifetime = 0;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => void }>();
const lastWrite = new Map<string, number>();

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

export function saveHistory<D extends DescMessage>(schema: D, key: string, value: MessageShape<D>) {
  if (!generation || !window.canopyDesktop?.history) return;
  const heldGeneration = generation;

  const write = () => {
    pending.delete(key);
    lastWrite.set(key, Date.now());
    void window.canopyDesktop?.history?.write(heldGeneration, key, toBinary(schema, value)).catch(() => {});
  };

  const delay = Math.max(0, 2000 - (Date.now() - (lastWrite.get(key) ?? 0)));
  const held = pending.get(key);

  if (held) {
    held.write = write;

    return;
  }

  if (!delay) write();
  else pending.set(key, { write, timer: setTimeout(() => pending.get(key)?.write(), delay) });
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
  lastWrite.clear();
  void window.canopyDesktop?.history?.clear().catch(() => {});
}
