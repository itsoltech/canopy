import { ui } from "@canopy/contracts";
import { clone } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "./core.ts";
import { readThreadRange, type RangeSourceStore } from "../computers/range-source.ts";
import type { RangeHead } from "../computers/range-source-rows.ts";
import { SequenceWindow } from "./sequence-window.ts";

type Readers = {
  users: number;
  version: number;
  headVersion: number;
  head?: RangeHead;
  unsubscribe: () => void;
  window: SequenceWindow;
  pending: Map<string, Promise<ui.ThreadSyncBatch>>;
};

const active = new WeakMap<GatewayCore, Map<string, Readers>>();

/** Active viewers share a scalar head and pending I/O, never completed payloads. */
export function sequenceRanges(core: GatewayCore, store: RangeSourceStore, thread: string) {
  const threads = active.get(core) ?? new Map<string, Readers>();
  active.set(core, threads);
  let readers = threads.get(thread);

  if (!readers) {
    const created: Readers = {
      users: 0,
      version: 0,
      headVersion: -1,
      unsubscribe: () => {},
      window: new SequenceWindow(store),
      pending: new Map(),
    };

    created.unsubscribe = core.hub.observeThread(thread, () => {
      created.version++;
      created.window.invalidate();
    });
    readers = created;
    threads.set(thread, readers);
  }

  readers.users++;
  let closed = false;

  return {
    window: (input: ui.WatchThreadRequest) => readers.window.read(input),
    async read(cursor: ui.ThreadSyncCursor) {
      const key = `${cursor.epoch}:${cursor.appliedSeq}`;

      // Many independently resuming viewers must not create an unbounded I/O cache.
      while (readers.pending.size >= 8 && !readers.pending.has(key)) await Promise.race(readers.pending.values());

      if (closed) throw new ConnectError("Thread reader is closed", Code.Canceled);
      let reading = readers.pending.get(key);

      if (!reading) {
        const version = readers.version;
        const head = readers.headVersion === version ? readers.head : undefined;

        reading = readThreadRange(store, cursor, 0n, "", head)
          .then((batch) => {
            if (!readers.head || readers.head.epoch !== batch.epoch || readers.head.seq < batch.headSeq)
              readers.head = { epoch: batch.epoch, seq: batch.headSeq };
            readers.headVersion = version;

            return batch;
          })
          .finally(() => readers.pending.delete(key));
        readers.pending.set(key, reading);
      }

      // Routing maps public IDs in place. Each consumer owns its bounded result.
      return clone(ui.ThreadSyncBatchSchema, await reading);
    },
    close() {
      if (closed) return;
      closed = true;

      if (--readers.users) return;
      readers.unsubscribe();
      readers.window.close();
      readers.pending.clear();
      threads.delete(thread);

      if (!threads.size) active.delete(core);
    },
  };
}
