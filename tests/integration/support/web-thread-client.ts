import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { EventSource, ErrorEvent } from "eventsource";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { ThreadWatchRecovery } from "@canopy/domain/thread-watch-recovery";
import { liveSource, type LiveSourceEnvironment } from "../../../apps/web/src/lib/shared/live-source.ts";
import { sseResponse } from "../../../apps/web/src/lib/server/sse.ts";
import { FeedBuilder } from "../../../apps/web/src/lib/features/threads/feed.ts";
import { timestampMs } from "@bufbuild/protobuf/wkt";

/** Real BFF SSE and the desktop reconnect loop, without a browser or component renderer. */
export function webThreadClient(api: {
  watchThread: (input: ui.WatchThreadRequest, options: { signal: AbortSignal }) => AsyncIterable<ui.ThreadUpdate>;
}) {
  let snapshot: ui.ThreadSnapshot | undefined;
  let stop = () => {};
  let live = false;
  let received = 0;
  let snapshots = 0;
  let stalled = false;
  const requests: string[] = [];
  const sources: EventSource[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const recovery = new ThreadWatchRecovery();
  const builder = new FeedBuilder();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const id = url.searchParams.get("id")!;
      const cursor = url.searchParams.get("cursor") ?? "";
      requests.push(cursor);
      const parsed = /^range:([^:]+):(\d+)$/.exec(cursor);

      return sseResponse(
        request,
        (signal) =>
          api.watchThread(
            create(ui.WatchThreadRequestSchema, {
              threadId: id,
              sequence: true,
              ...(parsed && { syncCursor: { threadId: id, epoch: parsed[1]!, appliedSeq: BigInt(parsed[2]!) } }),
            }),
            { signal },
          ),
        (update) => toJson(ui.ThreadUpdateSchema, update),
      );
    },
  });

  const environment: LiveSourceEnvironment = {
    source: (url) => {
      const source = new EventSource(url);
      sources.push(source);

      return source;
    },
    hidden: () => false,
    online: () => true,
    random: () => 1,
    schedule: (run, delay) => {
      const timer = setTimeout(run, delay);

      return () => clearTimeout(timer);
    },
    listen: (event, run) => {
      const set = listeners.get(event) ?? new Set();
      set.add(run);
      listeners.set(event, set);

      return () => {
        set.delete(run);
      };
    },
  };

  return {
    get snapshot() {
      return snapshot;
    },
    apply(next: ui.ThreadSnapshot) {
      snapshot = next;
    },
    get live() {
      return live;
    },
    get received() {
      return received;
    },
    get snapshots() {
      return snapshots;
    },
    requests,
    open(id: string) {
      stop();
      stalled = false;
      live = false;
      stop = liveSource(
        String(server.url),
        {
          stableMs: 10_000,
          url: () => `${server.url}?${new URLSearchParams({ id, cursor: snapshot?.cursor ?? "" })}`,
          ondrop: () => {
            live = false;
          },
          onerror: (failure) => recovery.failed(failure).action !== "stop",
          onmessage: (data) => {
            // A silent connection also withholds messages already buffered by SSE.
            if (stalled) return;
            const update = fromJson(ui.ThreadUpdateSchema, JSON.parse(data));
            snapshot = applyThreadUpdate(snapshot, update);
            received++;

            if (update.change.case === "snapshot") snapshots++;

            if (update.change.case === "batch" && update.change.value.caughtUp) {
              live = true;
              recovery.advanced(snapshot.syncCursor!.appliedSeq);
            }
          },
        },
        environment,
      );
    },
    disconnect() {
      stop();
      live = false;
    },
    stall() {
      stalled = true;
    },
    dropTransport() {
      sources.at(-1)!.onerror?.(new ErrorEvent("error"));
    },
    wake() {
      for (const run of listeners.get("online") ?? []) run();
    },
    rows() {
      const state = snapshot!;

      return builder.build({
        entries: state.items.flatMap((entry) =>
          entry.item
            ? [
                {
                  ...entry,
                  id: entry.item.itemId,
                  item: entry.item,
                  completedAt: entry.completedAt ? timestampMs(entry.completedAt) : undefined,
                },
              ]
            : [],
        ),
        turns: state.turns,
        notices: [],
        results: new Map(),
        steering: [],
        working: false,
        inheritedEntries: [],
        inheritedTurns: [],
        historyOpen: false,
        openWork: new Set(),
      });
    },
    async close() {
      stop();
      await server.stop(true);
    },
  };
}
