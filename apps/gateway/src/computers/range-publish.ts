import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputerStore } from "./store.ts";
import { readThreadRange } from "./range-source.ts";
import type { RemoteServe } from "./remote.ts";
import { rangeFailure } from "./range-failure.ts";
import { clearPublicationFailure, publicationFailure, savePublicationFailure } from "./range-publication-failure.ts";
import {
  rangeOverview,
  rangeOverviewUpdate,
  rangeThreadHeads,
  type RangeOverviewClock,
  type RangeThreadHead,
} from "./range-overview.ts";

type Waiting = { peer: string; cursor: ui.ThreadSyncCursor; done: () => void };

/** One unacknowledged batch per subscription. Acks confirm storage, not socket delivery. */
export class ThreadRangePublisher {
  readonly waiting = new Map<string, Waiting>();
  constructor(readonly store: ComputerStore) {}

  acknowledge(peer: string, input: link.ThreadRangeAck) {
    const pending = this.waiting.get(input.subscriptionId);
    const cursor = input.cursor;

    if (
      !pending ||
      pending.peer !== peer ||
      !cursor ||
      cursor.threadId !== pending.cursor.threadId ||
      cursor.epoch !== pending.cursor.epoch ||
      cursor.appliedSeq !== pending.cursor.appliedSeq
    )
      throw new ConnectError("Thread range acknowledgment does not match its subscription", Code.FailedPrecondition);
    pending.done();

    return create(link.ThreadRangeAckResultSchema);
  }

  async *publish(
    peer: string,
    input: link.MirrorRequest,
    signal: AbortSignal,
    serve: RemoteServe,
  ): AsyncGenerator<link.MirrorUpdate> {
    const cursors = new Map(input.threadCursors.map((cursor) => [cursor.threadId, cursor]));
    const subscription = crypto.randomUUID();
    let reportedThrough = 0;
    let lastHeartbeat = 0;
    let overviewClock: RangeOverviewClock | undefined;
    let threads: readonly RangeThreadHead[] = [];
    let refreshAt = 0;
    let readStarted = 0;

    try {
      while (!signal.aborted) {
        if (Date.now() >= refreshAt) {
          readStarted = Date.now();
          const overview = await rangeOverview(this.store, overviewClock);

          if (overview.changed) yield await rangeOverviewUpdate(serve, signal);

          overviewClock = overview.clock;
          threads = await rangeThreadHeads(this.store);
          refreshAt = Date.now() + 250;
          const ids = new Set(threads.map((thread) => thread.id));

          for (const id of cursors.keys())
            if (!ids.has(id)) {
              yield create(link.MirrorUpdateSchema, { removedThreadId: id });
              cursors.delete(id);
            }
        }

        let catchingUp = false;

        for (const thread of threads) {
          signal.throwIfAborted();
          const cursor = cursors.get(thread.id) ?? create(ui.ThreadSyncCursorSchema, { threadId: thread.id });

          if (
            thread.epoch === cursor.epoch &&
            thread.head !== null &&
            BigInt(thread.head) === cursor.appliedSeq &&
            Date.now() - lastHeartbeat < 5000
          )
            continue;
          const signature = `${thread.epoch}:${thread.head}:${thread.version}`;
          const blocked = publicationFailure(thread, signature);

          if (blocked && Date.now() < blocked.next) {
            if (blocked.at >= reportedThrough) {
              yield create(link.MirrorUpdateSchema, { rangeFailure: blocked.failure });
            }

            continue;
          }

          let batch: ui.ThreadSyncBatch | undefined;

          try {
            batch = await readThreadRange(
              this.store,
              cursor,
              0n,
              subscription,
              thread.epoch && thread.head !== null ? { epoch: thread.epoch, seq: BigInt(thread.head) } : undefined,
            );

            if (thread.failure_payload) {
              await clearPublicationFailure(this.store, thread.id);
              thread.failure_payload = null;
            }
          } catch (error) {
            const failure = rangeFailure(thread.id, ConnectError.from(error));
            const attempts = Math.min(2_147_483_647, (blocked?.attempts ?? 0) + 1);
            Object.assign(thread, await savePublicationFailure(this.store, thread.id, signature, failure, attempts));
            console.warn("Thread range publication failed", {
              frameBytes: failure.frameBytes,
              reason: failure.reason,
              code: failure.code,
              retryable: failure.retryable,
              attempts,
              maxBatchBytes: 65_536,
              maxRecords: 64,
            });
            yield create(link.MirrorUpdateSchema, { rangeFailure: failure });
            continue;
          }

          const next = create(ui.ThreadSyncCursorSchema, {
            threadId: batch.threadId,
            epoch: batch.epoch,
            appliedSeq: batch.appliedSeq,
          });

          catchingUp ||= !batch.caughtUp;
          thread.epoch = batch.epoch;
          thread.head = batch.headSeq.toString();

          const acknowledgment = new Promise<void>((done) => {
            this.waiting.set(subscription, { peer, cursor: next, done });
          });

          yield create(link.MirrorUpdateSchema, { rangeBatch: batch });
          await waitForAck(acknowledgment, signal);
          batch = undefined;
          this.waiting.delete(subscription);
          cursors.set(thread.id, next);
          lastHeartbeat = Date.now();
        }

        // A scalar watermark replaces a per-thread notification map. Read time
        // keeps failures committed during a scan visible on the following scan.
        reportedThrough = readStarted;

        if (Date.now() - lastHeartbeat >= 5000) {
          yield create(link.MirrorUpdateSchema, { heartbeat: true });
          lastHeartbeat = Date.now();
        }

        // Catch-up drains without delay. Once caught up, coalesce live edits at
        // the same cadence as the legacy mirror instead of immediately polling
        // again after every ACK (including a redundant empty read).
        if (!catchingUp) await delay(250, undefined, { signal });
      }
    } finally {
      this.waiting.delete(subscription);
    }
  }
}

async function waitForAck(ack: Promise<void>, signal: AbortSignal) {
  const timer = new AbortController();

  try {
    await Promise.race([
      ack,
      delay(15_000, undefined, { signal: AbortSignal.any([signal, timer.signal]) }).then(() => {
        throw new ConnectError("Thread range acknowledgment timed out", Code.DeadlineExceeded);
      }),
    ]);
  } finally {
    timer.abort();
  }
}
