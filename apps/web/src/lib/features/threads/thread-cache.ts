import { ThreadCache } from "@canopy/domain/thread-cache";
import { ui } from "@canopy/contracts";
import { loadHistory, removeHistory, saveHistory } from "../desktop/history.ts";
import { threadCacheTail } from "@canopy/domain/thread-cache-tail";

/**
 * SPA memory keeps whole snapshots, older pages included, so returning to a thread syncs only what changed.
 * Private Electron persistence keeps the bounded tail; a snapshot too large for memory keeps its tail too.
 */
class ClientThreadCache extends ThreadCache {
  #generation = 0;
  readonly #released = new Set<(id: string | undefined) => void>();

  /** Called when a thread's (id) or every (undefined) client copy must go: e.g. retained views. */
  onRelease(listener: (id: string | undefined) => void): () => void {
    this.#released.add(listener);

    return () => this.#released.delete(listener);
  }

  forget(id: string) {
    this.#generation++;
    super.delete(id);
    removeHistory(`thread_${id}`);

    for (const listener of this.#released) listener(id);
  }
  override clear() {
    this.#generation++;
    super.clear();

    for (const listener of this.#released) listener(undefined);
  }
  async load(id: string) {
    const generation = this.#generation;
    const cached = this.get(id) ?? (await loadHistory(ui.ThreadSnapshotSchema, `thread_${id}`));

    if (generation !== this.#generation) return undefined;

    if (cached?.thread?.id === id && !this.peek(id)) super.set(cached);

    return this.get(id);
  }
  override set(snapshot: ui.ThreadSnapshot, bytes?: number) {
    const id = snapshot.thread?.id;
    const tail = threadCacheTail(snapshot);
    super.set(snapshot, bytes);

    if (id && !this.peek(id)) super.set(tail);

    if (snapshot.thread && !snapshot.thread.deletedAt)
      saveHistory(ui.ThreadSnapshotSchema, `thread_${snapshot.thread.id}`, tail);
  }
}

// Snapshot objects are shared with retained views. Heap is roughly four times the encoded budget.
export const threadCache = new ClientThreadCache({ count: 32, bytes: 16 * 1024 * 1024 });
