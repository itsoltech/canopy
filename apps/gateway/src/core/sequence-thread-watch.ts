import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import type { RangeSourceStore } from "../computers/range-source.ts";
import { sequenceRanges } from "./sequence-ranges.ts";
import { readClientWindow } from "./client-window.ts";
import { sequenceControls, sequenceMetadata } from "./sequence-metadata.ts";
import { rangeFailure } from "../computers/range-failure.ts";
import { coreLog } from "./core-broadcast.ts";

/** Sequence reads use durable projections, independent of process-local fan-out. */
export async function* watchSequenceThread(core: GatewayCore, input: ui.WatchThreadRequest, signal: AbortSignal) {
  try {
    yield* sequenceThread(core, input, signal);
  } catch (cause) {
    if (signal.aborted) return;
    const error = ConnectError.from(cause);
    const failure = rangeFailure(input.threadId, error);
    coreLog(
      core,
      `Thread watch failed ${JSON.stringify({
        code: failure.code,
        reason: failure.reason,
        retryable: failure.retryable,
        frameBytes: failure.frameBytes,
      })}`,
    );
    throw new ConnectError("Live updates for this thread are unavailable", error.code, {
      "canopy-error-scope": "thread",
      "canopy-sync-reason": failure.reason,
    });
  }
}

async function* sequenceThread(core: GatewayCore, input: ui.WatchThreadRequest, signal: AbortSignal) {
  const { runtime, userId: owner } = core[coreState].options;

  const store: RangeSourceStore = {
    owner,
    runtime,
    query<A extends object>(text: string, params: unknown[] = []) {
      return runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.unsafe<A>(text, params);
        }),
      );
    },
  };

  const ranges = sequenceRanges(core, store, input.threadId);

  try {
    yield* sequenceView(core, store, ranges, input, signal);
  } finally {
    ranges.close();
  }
}

async function* sequenceView(
  core: GatewayCore,
  store: RangeSourceStore,
  ranges: ReturnType<typeof sequenceRanges>,
  input: ui.WatchThreadRequest,
  signal: AbortSignal,
) {
  const owner = store.owner;
  let cursor = input.syncCursor;
  const paging = !!input.beforeItemId || !!input.beforeTurnId || !!input.targetItemId;

  // A cursor belongs to exactly one thread. Unknown epochs receive a fresh bounded window.
  if (cursor && cursor.threadId !== input.threadId)
    throw new ConnectError("Thread cursor identity mismatch", Code.InvalidArgument);

  const clock = (
    await store.query<{ epoch: string; head: string }>(
      `SELECT c.epoch,c.head_seq::text AS head FROM thread_replication_clock c
    JOIN threads t ON t.id=c.thread_id WHERE c.thread_id=$1::uuid AND t.owner_user_id=$2::uuid AND t.deleted_at IS NULL`,
      [input.threadId, owner],
    )
  )[0];

  if (!cursor || !clock || cursor.epoch !== clock.epoch || cursor.appliedSeq > BigInt(clock.head) || paging) {
    const snapshot = await ranges.window(input);
    cursor = snapshot.syncCursor!;
    yield create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } });

    if (paging) return;
  }

  yield await sequenceControls(core, input.threadId);
  const metadata = sequenceMetadata(core, input.threadId);
  const close = () => metadata.close();
  signal.addEventListener("abort", close, { once: true });
  let lastSent = 0;
  let controlsAt = Date.now();

  try {
    while (!signal.aborted) {
      const version = metadata.version;

      for (const update of metadata.drain()) yield update;

      if (Date.now() - controlsAt >= 5000) {
        yield await sequenceControls(core, input.threadId);
        controlsAt = Date.now();
      }

      let batch: ui.ThreadSyncBatch | undefined = await ranges.read(cursor);

      if (batch.epoch !== cursor.epoch) {
        const snapshot = await readClientWindow(
          store,
          create(ui.WatchThreadRequestSchema, { ...input, historyVersion: cursor.epoch }),
        );

        cursor = snapshot.syncCursor!;
        yield create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } });
        continue;
      }

      if (batch.records.length || Date.now() - lastSent >= 5000) {
        yield create(ui.ThreadUpdateSchema, { change: { case: "batch", value: batch } });
        cursor = create(ui.ThreadSyncCursorSchema, {
          threadId: batch.threadId,
          epoch: batch.epoch,
          appliedSeq: batch.appliedSeq,
        });
        lastSent = Date.now();
      }

      const caughtUp = batch.caughtUp;
      batch = undefined;

      if (caughtUp) await metadata.wait(version, signal, core[coreState].options.watchProbeMs ?? 5000);
    }
  } finally {
    signal.removeEventListener("abort", close);
    metadata.close();
  }
}
