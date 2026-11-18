import type { ui } from "@canopy/contracts";
import { threadCacheCurrent } from "@canopy/domain/thread-warm-set";
import { threadCache } from "./thread-cache.ts";

let overviewHeads: readonly ui.ThreadSyncCursor[] = [];

/** Compare the renderer's checkpoint with the shared BFF's reactive overview. */
export const threadOverviewHead = (id: string) => overviewHeads.find((head) => head.threadId === id);

export function receiveThreadHeads(heads: readonly ui.ThreadSyncCursor[]) {
  overviewHeads = heads;
}

/** Background tails stay in the BFF; an already current renderer can reuse its own loaded history. */
export function warmCacheHit(id: string, open: ui.ThreadSnapshot | undefined) {
  return threadCacheCurrent(open ?? threadCache.get(id), threadOverviewHead(id));
}

/** The renderer performs no background history HTTP requests. */
export function threadWarmingUsage() {
  return { requests: 0, payloadBytes: threadCache.usage.bytes, entries: threadCache.usage.count };
}
