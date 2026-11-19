import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Provider, ThreadStatus, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { Code, ConnectError } from "@connectrpc/connect";
import { SqlClient } from "effect/sql";
import { Hub } from "../../apps/gateway/src/core/hub.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

async function firstUpdate<T>(stream: AsyncIterable<T>): Promise<T> {
  for await (const value of stream) return value;
  throw new Error("Stream ended before its first update");
}

async function runningThread(
  gw: TestGateway,
  projectId: string,
  workspaceId: string,
  title: string,
  signal: AbortSignal,
) {
  const threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title })).thread!.id;
  const turnId = (await gw.api.sendMessage({ threadId, text: title, clientRequestId: crypto.randomUUID() })).turn!.id;

  const running = await eventually(
    () => gw.api.getThread({ threadId }),
    (r) => r.thread?.status === "running",
  );

  expect(running.thread?.status).toBe("running");

  // The gRPC client's periodic revision probe may legitimately replace live events with a fresh snapshot.
  // Read the underlying WatchThread producer to check every event it fans out.
  const stream = gw.core.watchThread(threadId, signal, "", true);
  const first = await stream.next();

  if (first.done || first.value.change.case !== "snapshot") throw new Error("Missing initial thread snapshot");
  const snapshot = first.value.change.value;
  expect(snapshot.cursor).toBeTruthy();
  const activity: bigint[] = [];

  async function untilThread(matches: (thread: ui.Thread) => boolean) {
    for (;;) {
      const next = await stream.next();

      if (next.done) throw new Error("WatchThread ended before the expected update");
      const change = next.value.change;

      if (change.case === "event" && change.value.event?.body.case === "activity") activity.push(change.value.seq);

      if (change.case === "thread" && matches(change.value)) return change.value;
    }
  }

  return { threadId, turnId, snapshot, activity, untilThread, close: () => stream.return(undefined) };
}

async function activityBurst(
  gw: TestGateway,
  threads: Awaited<ReturnType<typeof runningThread>>[],
  from: number,
  to: number,
) {
  const reading = threads.map((t) => t.untilThread((row) => row.lastSeq >= t.snapshot.lastSeq + BigInt(to)));

  for (let i = from; i <= to; i++)
    for (const t of threads)
      gw.worker.emit(
        t.threadId,
        t.turnId,
        {
          case: "activity",
          value: { status: ThreadStatus.RUNNING, runningTurnId: t.turnId },
        },
        JSON.stringify({ ordinal: i }),
      );
  await Promise.all(reading);
}

async function throughProject(overview: AsyncGenerator<ui.OverviewUpdate>, projectId: string, name: string) {
  const threads = new Map<string, ui.Thread[]>();

  for (;;) {
    const next = await overview.next();

    if (next.done) throw new Error(`WatchOverview ended before the project change "${name}"`);
    const change = next.value.change;

    if (change.case === "project" && change.value.id === projectId && change.value.name === name) return threads;

    if (change.case === "thread") {
      const rows = threads.get(change.value.id) ?? [];
      rows.push(change.value);
      threads.set(change.value.id, rows);
    }
  }
}

test.skipIf(!dockerAvailable)(
  "a stalled overview preserves thread transitions and barriers while worker history stays ordered and resumable",
  async () => {
    const gw = await startTestGateway();
    gw.worker.holdTurns = true;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
    // Hold the actual gateway generator at its snapshot so HTTP/2 buffering cannot drain the subscriber.
    const overview = gw.core.watchOverview(signal, true);

    const threads: Awaited<ReturnType<typeof runningThread>>[] = [];

    try {
      const projectId = (await gw.api.createProject({ name: "Burst" })).project!.id;

      const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" }))
        .workspace!.id;

      for (const name of ["First", "Second"])
        threads.push(await runningThread(gw, projectId, workspaceId, name, signal));
      expect((await overview.next()).value?.change.case).toBe("mobileSnapshot");

      await activityBurst(gw, threads, 1, 120);
      await gw.api.renameProject({ projectId, name: "Between bursts" });
      const flagged = threads[0]!.threadId;
      await gw.api.setThreadRead({ threadId: flagged, unread: true });
      await gw.api.setThreadRead({ threadId: flagged, unread: false });
      await activityBurst(gw, threads, 121, 150);

      for (const t of threads) gw.worker.finish(t.threadId, t.turnId, `Answer for ${t.threadId}`);

      for (const t of threads) {
        const completed = await t.untilThread((row) => row.unseenResult === "completed");
        await gw.api.markThreadSeen({ threadId: t.threadId, upToSeq: completed.lastSeq });
      }

      await gw.api.renameProject({ projectId, name: "After both turns" });

      const before = await throughProject(overview, projectId, "Between bursts");
      const after = await throughProject(overview, projectId, "After both turns");
      await overview.return(undefined);
      const reconnect = await firstUpdate(gw.api.watchOverview({ includeSnapshot: true }, { signal }));

      if (reconnect.change.case !== "mobileSnapshot") throw new Error("Missing overview snapshot after reconnect");

      for (const t of threads) {
        expect(before.get(t.threadId)?.at(-1)).toMatchObject({ status: "running", lastSeq: t.snapshot.lastSeq + 120n });
        const delivered = after.get(t.threadId) ?? [];
        const marked = delivered.findIndex((row) => row.markedUnread);

        if (t.threadId === flagged) expect(marked).toBeGreaterThanOrEqual(0);

        const progressed = delivered.findIndex(
          (row) => !row.markedUnread && row.status === "running" && row.lastSeq === t.snapshot.lastSeq + 150n,
        );

        expect(progressed).toBeGreaterThan(marked);
        expect(delivered.findIndex((row) => row.unseenResult === "completed")).toBeGreaterThan(progressed);
        const current = reconnect.change.value.threads.find((row) => row.id === t.threadId)!;
        expect(current).toMatchObject({ status: "idle", markedUnread: false, unseenResult: "" });
        expect(delivered.at(-1)).toEqual(current);

        const expected = Array.from({ length: 150 }, (_, i) => t.snapshot.lastSeq + BigInt(i + 1));
        expect(t.activity).toEqual(expected);

        const stored = await gw.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql<{ seq: string; ordinal: number }>`
              SELECT seq::text, (raw->>'ordinal')::int AS ordinal FROM thread_events
              WHERE thread_id = ${t.threadId}::uuid AND kind = 'activity'
              ORDER BY thread_events.seq`,
          ),
        );

        expect(stored.map((row) => BigInt(row.seq))).toEqual(expected);
        expect(stored.map((row) => row.ordinal)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));

        // A fresh RPC from the pre-burst checkpoint returns the persisted answer and final turn.
        const update = await firstUpdate(
          gw.api.watchThread({ threadId: t.threadId, incremental: true, cursor: t.snapshot.cursor }, { signal }),
        );

        expect(update.change.case).toBe("delta");
        const state = applyThreadUpdate(t.snapshot, update);
        expect(state.turns.find((turn) => turn.id === t.turnId)?.status).toBe("completed");
        expect(
          state.items.some(
            ({ item }) =>
              item?.content.case === "agentMessage" && item.content.value.text === `Answer for ${t.threadId}`,
          ),
        ).toBe(true);
        expect(state.lastSeq).toBe(current.lastSeq);
      }
    } finally {
      abort.abort();
      await overview.return(undefined);
      await Promise.all(threads.map((thread) => thread.close()));
      await gw.close();
    }
  },
  90_000,
);

test.each([
  { limit: "item count", count: 257, previewBytes: 0 },
  { limit: "encoded bytes", count: 129, previewBytes: 64 * 1024 },
])(
  "overview reports DataLoss at the $limit limit when pending transitions must all be delivered",
  async ({ count, previewBytes }) => {
    const hub = new Hub();
    const slow = hub.subscribeOverview();
    const fast = hub.subscribeOverview();
    const reader = fast.updates[Symbol.asyncIterator]();
    const preview = "a".repeat(previewBytes);

    let bytes = 0;
    const received: bigint[] = [];

    try {
      for (let n = 0; n < count; n++) {
        const lastSeq = BigInt(n + 1);

        const frame = create(ui.OverviewUpdateSchema, {
          change: {
            case: "thread",
            value: {
              id: "thread",
              status: "running",
              lastSeq,
              pendingInteractions: 1,
              noticePreview: preview,
            },
          },
        });

        hub.publishOverview(frame);
        bytes += toBinary(ui.OverviewUpdateSchema, frame).length;
        expect(slow.updates.closed).toBe(n + 1 > 256 || bytes > 8 * 1024 * 1024);
        const next = await reader.next();

        if (next.done || next.value.change.case !== "thread") throw new Error("Healthy overview lost a thread");
        received.push(next.value.change.value.lastSeq);
      }

      expect(received).toEqual(Array.from({ length: count }, (_, n) => BigInt(n + 1)));

      const failure = await slow.updates[Symbol.asyncIterator]()
        .next()
        .catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(ConnectError);
      expect(failure).toMatchObject({ code: Code.DataLoss });
    } finally {
      slow.close();
      fast.close();
    }
  },
);
