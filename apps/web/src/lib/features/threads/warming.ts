import { create, toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ThreadWarmer } from "@canopy/domain/thread-warmer";
import { threadCacheCurrent } from "@canopy/domain/thread-warm-set";
import { bodyJson, isJsonArray } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";
import { clientMeasurements } from "#lib/features/diagnostics/client.ts";
import { threadCache } from "./thread-cache.ts";

let current: ThreadWarmer | undefined;

async function* read(id: string, syncCursor: ui.ThreadSyncCursor | undefined, signal: AbortSignal) {
  const response = await fetch(`/api/threads/${encodeURIComponent(id)}/warm`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toJson(ui.WatchThreadRequestSchema, create(ui.WatchThreadRequestSchema, { syncCursor }))),
    priority: "low",
  });

  if (!response.ok) throw new Error("Background thread read unavailable");
  const updates = await bodyJson(response);

  if (!isJsonArray(updates) || updates.length > 4) throw new Error("Invalid background thread read");

  for (const update of updates) yield decode(ui.ThreadUpdateSchema, update);
}

/** Threads kept on the client after their screen closed; warming updates them in place. */
export interface RetainedSource {
  snapshot(id: string): ui.ThreadSnapshot | undefined;
  refresh(snapshot: ui.ThreadSnapshot, replaced: boolean): boolean;
}

export function createThreadWarming(retained: RetainedSource) {
  return new ThreadWarmer(
    {
      peek: (id) => retained.snapshot(id) ?? threadCache.peek(id),
      load: async (id) => retained.snapshot(id) ?? threadCache.load(id),
      save: (snapshot, replaced) => {
        if (!retained.refresh(snapshot, replaced)) threadCache.set(snapshot);
      },
    },
    read,
    { recent: 12, count: 32, intervalMs: 2000, retryMs: 30_000, requested: () => clientMeasurements.record(14, 1) },
  );
}

export function connectThreadWarming(warmer: ThreadWarmer, live: () => boolean) {
  current = warmer;
  const update = () => warmer.enable(!document.hidden && navigator.onLine && live());
  document.addEventListener("visibilitychange", update);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();

  return () => {
    current = undefined;
    warmer.close();
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  };
}

/** The open snapshot (retained or cached) is current with the head warming last saw. */
export function warmCacheHit(id: string, open: ui.ThreadSnapshot | undefined) {
  return !!current?.enabled && threadCacheCurrent(open ?? threadCache.get(id), current.head(id));
}

export function pauseThreadWarming() {
  current?.yieldToNavigation();
}

export function observeThreadCacheMemory() {
  clientMeasurements.record(15, threadCache.usage.bytes);
}

/** Numeric-only local probe; payload accounting is distinct from browser heap. */
export function threadWarmingUsage() {
  return { requests: current?.requests ?? 0, payloadBytes: threadCache.usage.bytes, entries: threadCache.usage.count };
}
