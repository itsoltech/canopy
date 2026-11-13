import { ThreadCache } from "@canopy/domain/thread-cache";
import { ui } from "@canopy/contracts";
import { loadHistory, removeHistory, saveHistory } from "../desktop/history.ts";
import { threadCacheTail } from "@canopy/domain/thread-cache-tail";

/** SPA memory, with private Electron persistence when the preload bridge is available. */
class ClientThreadCache extends ThreadCache {
  forget(id: string) {
    super.delete(id);
    removeHistory(`thread_${id}`);
  }
  async load(id: string) {
    const cached = this.get(id) ?? (await loadHistory(ui.ThreadSnapshotSchema, `thread_${id}`));

    if (cached?.thread?.id === id) super.set(threadCacheTail(cached));

    return this.get(id);
  }
  override set(snapshot: ui.ThreadSnapshot) {
    snapshot = threadCacheTail(snapshot);
    super.set(snapshot);

    if (snapshot.thread && !snapshot.thread.deletedAt)
      saveHistory(ui.ThreadSnapshotSchema, `thread_${snapshot.thread.id}`, snapshot);
  }
}

export const threadCache = new ClientThreadCache({ count: 32, bytes: 32 * 1024 * 1024 });
