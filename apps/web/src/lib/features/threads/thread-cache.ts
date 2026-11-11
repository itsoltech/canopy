import { ThreadCache } from "@canopy/domain/thread-cache";
import { ui } from "@canopy/contracts";
import { loadHistory, removeHistory, saveHistory } from "../desktop/history.ts";

/** SPA memory, with private Electron persistence when the preload bridge is available. */
class ClientThreadCache extends ThreadCache {
  forget(id: string) {
    super.delete(id);
    removeHistory(`thread_${id}`);
  }
  async load(id: string) {
    const cached = this.get(id) ?? (await loadHistory(ui.ThreadSnapshotSchema, `thread_${id}`));

    if (cached?.thread?.id === id) super.set(cached);

    return this.get(id);
  }
  override set(snapshot: ui.ThreadSnapshot, bytes?: number) {
    super.set(snapshot, bytes);

    if (snapshot.thread && !snapshot.thread.deletedAt)
      saveHistory(ui.ThreadSnapshotSchema, `thread_${snapshot.thread.id}`, snapshot);
  }
}

export const threadCache = new ClientThreadCache();
