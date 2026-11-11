import { create, toBinary, type Message } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { ThreadSyncGap } from "@canopy/domain/thread-sync";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "./remote.ts";
import type { LinkedComputers } from "./runtime.ts";

export async function consumeThreadRanges(
  host: LinkedComputers,
  node: string,
  subscription: string,
  updates: AsyncIterable<Message>,
  signal: AbortSignal,
  notify: () => void,
) {
  let lastNotified = 0;

  for await (const message of updates) {
    signal.throwIfAborted();
    const update = linkedMessage(link.MirrorUpdateSchema, message);

    if (update.rangeFailure) {
      const failure = update.rangeFailure;

      const reasons = new Set([
        "decode_error",
        "size_limit",
        "invalid_range",
        "invalid_cursor",
        "invalid_record",
        "access_denied",
        "thread_removed",
        "timeout",
        "stream_unavailable",
        "watch_failed",
      ]);

      const reason = reasons.has(failure.reason) ? failure.reason : "watch_failed";
      await host.store.query(
        `INSERT INTO thread_range_failures(owner_user_id,origin_node_id,thread_id,reason,code,retryable)
        SELECT $1::uuid,$2,$3::uuid,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM computer_mirror_state
          WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND subscription_id=$7::uuid)
        ON CONFLICT(owner_user_id,origin_node_id,thread_id) DO UPDATE
          SET reason=excluded.reason,code=excluded.code,retryable=excluded.retryable,failed_at=now()`,
        [host.store.owner, node, failure.threadId, reason, failure.code, failure.retryable, subscription],
      );
      console.warn("Thread range catch-up failed", { reason, code: failure.code, retryable: failure.retryable });
      notify();
    }

    if (update.overview)
      await host.store.query(
        "UPDATE computer_mirror_state SET overview=$3 WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND subscription_id=$4::uuid",
        [host.store.owner, node, toBinary(ui.GetOverviewResponseSchema, update.overview), subscription],
      );

    if (update.removedThreadId) {
      await host.store.query(
        "DELETE FROM thread_range_state WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
        [host.store.owner, node, update.removedThreadId],
      );
      await host.store.query(
        "DELETE FROM computer_mirror_threads WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
        [host.store.owner, node, update.removedThreadId],
      );
      notify();
    }

    const batch = update.rangeBatch;

    if (!batch) continue;

    try {
      await host.ranges.apply(node, subscription, batch);
    } catch (error) {
      if (!(error instanceof ThreadSyncGap)) throw error;

      let cursor = create(ui.ThreadSyncCursorSchema, {
        threadId: batch.threadId,
        epoch: batch.epoch,
        appliedSeq: error.appliedSeq,
      });

      while (cursor.appliedSeq < batch.baseSeq) {
        const repaired = linkedMessage(
          ui.ThreadSyncBatchSchema,
          await one(
            host,
            node,
            link.ThreadMirrorService.method.getThreadRange,
            create(link.ThreadRangeRequestSchema, { cursor, throughSeq: batch.baseSeq }),
            signal,
          ),
        );

        if (repaired.epoch !== batch.epoch || repaired.appliedSeq <= cursor.appliedSeq)
          throw new ConnectError("Thread range changed during repair", Code.DataLoss);
        cursor = await host.ranges.apply(node, subscription, repaired);
      }

      await host.ranges.apply(node, subscription, batch);
    }

    await host.store.query(
      `DELETE FROM thread_range_failures WHERE owner_user_id=$1::uuid
      AND origin_node_id=$2 AND thread_id=$3::uuid`,
      [host.store.owner, node, batch.threadId],
    );

    // This call is deliberately after the database commit. A lost ACK only replays a durable cursor.
    await one(
      host,
      node,
      link.ThreadMirrorService.method.ackThreadRange,
      create(link.ThreadRangeAckSchema, {
        subscriptionId: batch.subscriptionId,
        cursor: { threadId: batch.threadId, epoch: batch.epoch, appliedSeq: batch.appliedSeq },
      }),
      signal,
    );

    if (batch.caughtUp || Date.now() - lastNotified >= 250) {
      notify();
      lastNotified = Date.now();
    }
  }
}

async function one(
  host: LinkedComputers,
  node: string,
  method: Parameters<LinkedComputers["remote"]>[1],
  request: Message,
  signal: AbortSignal,
) {
  for await (const response of host.remote(node, method, request, signal)) return response;
  throw new ConnectError("Missing thread range response", Code.Unavailable);
}
