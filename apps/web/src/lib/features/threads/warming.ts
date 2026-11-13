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

export function createThreadWarming() {
  return new ThreadWarmer(
    {
      peek: (id) => threadCache.peek(id),
      load: (id) => threadCache.load(id),
      save: (snapshot) => threadCache.set(snapshot),
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

export function warmCacheHit(id: string) {
  return !!current?.enabled && threadCacheCurrent(threadCache.get(id), current.head(id));
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
