import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import { computerLink as link, ItemSchema, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId, THREAD_RANGES } from "@canopy/domain/computers";
import { ThreadSyncGap, validateThreadBatch } from "@canopy/domain/thread-sync";
import { ConnectError, Code } from "@connectrpc/connect";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { computersState } from "../../apps/gateway/src/computers/runtime-context.ts";
import { computersSyncMirror } from "../../apps/gateway/src/computers/runtime-mirrors.ts";
import { readRangeContent } from "../../apps/gateway/src/computers/range-content-read.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable thread sequence ranges over real gateway links", () => {
  let a: Awaited<ReturnType<typeof startTestGateway>>;
  let b: Awaited<ReturnType<typeof startTestGateway>>;
  let local: ReturnType<typeof linkedComputers>;
  let home: ReturnType<typeof linkedComputers>;
  let source: ComputerStore;
  let target: ComputerStore;
  let thread: string;
  let node: string;
  const batches: ui.ThreadSyncBatch[] = [];
  let maxBatchBytes = 0;
  let maxHeap = 0;
  let initialHeap = 0;
  let pausedAt = 0n;
  let applyFailure: Error | undefined;
  let heartbeats = 0;

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    target = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    source = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    local = linkedComputers({ store: target, core: a.core, host: "127.0.0.1", serve: remoteServe(uiHandlers(a.core)) });
    home = linkedComputers({ store: source, core: b.core, host: "127.0.0.1", serve: remoteServe(uiHandlers(b.core)) });
    const project = (await b.api.createProject({ name: "Range synchronization" })).project!.id;

    const workspace = (
      await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/ranges" })
    ).workspace!.id;

    thread = (
      await b.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Large range history",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const item = create(ItemSchema, {
      status: ItemStatus.COMPLETED,
      content: { case: "commandExecution", value: { command: "bun test", output: "x".repeat(32_700) } },
    });

    await source.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-' || n,'commandExecution','completed',
        $2::jsonb || jsonb_build_object('itemId','item-' || n),n,n FROM generate_series(1,3000) n`,
      [thread, JSON.stringify(toJson(ItemSchema, item))],
    );
    await source.query("UPDATE threads SET last_seq=3000 WHERE id=$1::uuid", [thread]);
    validateThreadBatch(await readThreadRange(source, create(ui.ThreadSyncCursorSchema, { threadId: thread })), 0n);
    a.core.computers = local;
    a.core.network = local.options.network;
    b.core.computers = home;
    b.core.network = home.options.network;
    await local.start();
    await home.start();
    node = home.hello().nodeId;
    const publish = home.rangePublisher.publish.bind(home.rangePublisher);
    home.rangePublisher.publish = async function* (...args) {
      for await (const update of publish(...args)) {
        if (update.heartbeat) heartbeats++;

        if (update.rangeBatch?.threadId === thread) {
          batches.push(update.rangeBatch);
          maxBatchBytes = Math.max(maxBatchBytes, toBinary(ui.ThreadSyncBatchSchema, update.rangeBatch).length);
          maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
        }

        yield update;
      }
    };

    // Kill this subscription after a durable batch and before its ACK crosses the link.
    const apply = local.ranges.apply.bind(local.ranges);
    let appliedBatches = 0;
    local.ranges.apply = async (...args) => {
      const cursor = await apply(...args).catch((error: Error) => {
        applyFailure = error;
        throw error;
      });

      if (args[2].threadId === thread && ++appliedBatches === 3) {
        pausedAt = cursor.appliedSeq;
        local[computersState].mirroring.get(node)?.abort();
      }

      return cursor;
    };

    initialHeap = process.memoryUsage().heapUsed;
    await home.pair(local.addresses[0]!, (await local.createPairing()).code);
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([local?.close(), home?.close()]);
    await a?.close();
    await b?.close();
  });

  test("a killed catch-up resumes from its durable sequence", async () => {
    expect(local.hello().capabilities).toContain(THREAD_RANGES);
    expect(
      await eventually(
        async () => {
          if (applyFailure) throw applyFailure;

          return pausedAt > 0n;
        },
        Boolean,
        15_000,
      ),
    ).toBe(true);
    expect(await eventually(async () => !local[computersState].mirroring.has(node), Boolean, 5000)).toBe(true);
    const stored = (await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread)!;
    expect(stored.appliedSeq).toBe(pausedAt);
    const seen = batches.length;
    computersSyncMirror(local, node);
    expect(await eventually(async () => batches.length > seen, Boolean, 5000)).toBe(true);
    expect(batches[seen]!.baseSeq).toBe(pausedAt);
    expect(batches[seen]!.records[0]?.seq).toBe(pausedAt + 1n);
  }, 25_000);

  test("a roughly 100 MB thread catches up within both batch limits", async () => {
    expect(
      await eventually(
        async () => {
          const rows = await target.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM thread_range_entities
        WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid AND kind='item'`,
            [a.userId, node, thread],
          );

          return Number(rows[0]!.count);
        },
        (count) => count === 3000,
        30_000,
      ),
    ).toBe(3000);
    expect(await eventually(async () => batches.some((batch) => batch.caughtUp), Boolean, 5000)).toBe(true);
    expect(maxBatchBytes).toBeLessThanOrEqual(65_536);
    expect(batches.every((batch) => batch.records.length <= 64)).toBe(true);
    expect(batches.some((batch) => batch.records.some((record) => record.content))).toBe(true);
    expect(home.rangePublisher.waiting.size).toBeLessThanOrEqual(1);
    expect((await local.computer(node))?.status).toBe("connected");
    console.info("Thread range transfer bounds", {
      sourceBytes: 98_100_000,
      maxBatchBytes,
      maxRecords: Math.max(...batches.map((batch) => batch.records.length)),
      heapGrowthBytes: maxHeap - initialHeap,
    });
  }, 40_000);

  test("caught-up mirrors stay live without empty batches or acknowledgments", async () => {
    await eventually(
      async () => home.rangePublisher.waiting.size,
      (size) => size === 0,
    );
    const count = batches.length;
    const heartbeat = heartbeats;
    await Bun.sleep(6200);
    expect(batches.length).toBe(count);
    expect(heartbeats).toBeGreaterThan(heartbeat);
    expect(home.rangePublisher.waiting.size).toBe(0);
    expect((await local.computer(node))?.status).toBe("connected");
  }, 15_000);

  test("every batch reports the exact remaining journal count", () => {
    for (const batch of batches) {
      expect(batch.remaining).toBe(batch.headSeq - batch.appliedSeq);
      expect(batch.caughtUp).toBe(batch.remaining === 0n);
      expect(batch.appliedSeq - batch.baseSeq).toBe(BigInt(batch.records.length));
    }
  });

  test("sealed replay uses a bounded cached head and still enforces ownership", async () => {
    const stored = (await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread)!;
    const cursor = create(ui.ThreadSyncCursorSchema, { threadId: thread, epoch: stored.epoch });
    const head = { epoch: stored.epoch, seq: stored.appliedSeq };
    const replay = await readThreadRange(source, cursor, 0n, "", head);
    validateThreadBatch(replay, 0n);
    expect(replay.headSeq).toBe(head.seq);
    expect(replay.remaining).toBe(head.seq - replay.appliedSeq);
    expect(toBinary(ui.ThreadSyncBatchSchema, replay).length).toBeLessThanOrEqual(65_536);

    const repaired = await range(cursor, replay.appliedSeq);
    expect(repaired.records.map((record) => record.seq)).toEqual(replay.records.map((record) => record.seq));
    const otherOwner = new ComputerStore(b.runtime, crypto.randomUUID(), b.secretsKey);
    await expect(readThreadRange(otherOwner, cursor, 0n, "", head)).rejects.toThrow();

    const reset = await readThreadRange(
      source,
      create(ui.ThreadSyncCursorSchema, { ...cursor, epoch: crypto.randomUUID() }),
      0n,
      "",
      head,
    );

    expect(reset.epoch).toBe(stored.epoch);
    expect(reset.baseSeq).toBe(0n);
  });

  test("a missing range is repaired over gRPC without a snapshot", async () => {
    const state = (await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread)!;
    const repairedNode = local.hello().nodeId;
    // The reverse mirror consumer has no projection of this source thread.
    const destination = home.ranges;
    const subscription = await destination.begin(repairedNode);
    const cursor = create(ui.ThreadSyncCursorSchema, { threadId: thread, epoch: state.epoch });
    const first = await range(cursor);
    const later = await range(create(ui.ThreadSyncCursorSchema, { ...cursor, appliedSeq: first.appliedSeq }));
    await expect(destination.apply(repairedNode, subscription, later)).rejects.toThrow(ThreadSyncGap);
    const restored = await range(cursor, later.baseSeq);
    await destination.apply(repairedNode, subscription, restored);
    await destination.apply(repairedNode, subscription, later);
    expect((await destination.cursors(repairedNode)).find((entry) => entry.threadId === thread)?.appliedSeq).toBe(
      later.appliedSeq,
    );
  });

  test("live metadata uses the same sequence stream and unary remains healthy", async () => {
    const before = (await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread)!.appliedSeq;
    await b.api.updateThread({ threadId: thread, title: "Updated through live ranges" });
    expect(
      await eventually(
        async () => (await local.mirror.thread(node, thread))?.title,
        (title) => title === "Updated through live ranges",
        10_000,
      ),
    ).toBe("Updated through live ranges");
    expect((await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread)!.appliedSeq).toBeGreaterThan(
      before,
    );
    expect((await b.api.getThread({ threadId: thread })).thread?.title).toBe("Updated through live ranges");
  }, 15_000);

  test("picker metadata still propagates independently of transcript ranges", async () => {
    const original = (await b.api.getThread({ threadId: thread })).thread!;
    await b.api.updateWorkspace({ workspaceId: original.workspaceId, label: "Updated range workspace" });
    expect(
      await eventually(
        async () =>
          (await local.mirror.overview(node)).projects
            .flatMap((project) => project.workspaces)
            .find((workspace) => workspace.id === qualifyId(original.workspaceId, node))?.label,
        (label) => label === "Updated range workspace",
        5000,
      ),
    ).toBe("Updated range workspace");
  });

  test("legacy moved history is streamed entity by entity with lazy oversized output", async () => {
    const original = (await b.api.getThread({ threadId: thread })).thread!;

    const moved = (
      await b.api.createThread({
        projectId: original.projectId,
        workspaceId: original.workspaceId,
        provider: Provider.CODEX,
        title: "Moved range history",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const turn = crypto.randomUUID();

    const history = toBinary(
      ui.ThreadSnapshotSchema,
      create(ui.ThreadSnapshotSchema, {
        turns: [{ id: turn, ordinal: 1, status: "completed" }],
        items: [
          {
            turnId: turn,
            firstSeq: 1n,
            lastSeq: 1n,
            item: {
              itemId: "legacy-large",
              status: ItemStatus.COMPLETED,
              content: {
                case: "commandExecution",
                value: { command: "bun test", output: "x".repeat(17 * 1024 * 1024) },
              },
            },
          },
        ],
      }),
    );

    await source.query(
      `INSERT INTO computer_moved_threads(thread_id,from_node_id,history,ordinal_turn_id)
      VALUES($1::uuid,$2,$3,$4::uuid)`,
      [moved, local.hello().nodeId, history, turn],
    );
    let cursor = create(ui.ThreadSyncCursorSchema, { threadId: moved });
    const records: ui.ThreadSyncRecord[] = [];

    do {
      const batch = await readThreadRange(source, cursor);
      validateThreadBatch(batch, batch.baseSeq);
      records.push(...batch.records);
      cursor = create(ui.ThreadSyncCursorSchema, { threadId: moved, epoch: batch.epoch, appliedSeq: batch.appliedSeq });

      if (batch.caughtUp) break;
    } while (records.length < 100);

    const item = records.find((record) => record.value.case === "item");
    expect(item?.value.case).toBe("item");
    expect(item?.content?.sizeBytes).toBeGreaterThan(16n * 1024n * 1024n);
    expect(toBinary(ui.ThreadSyncRecordSchema, item!).length).toBeLessThan(24 * 1024);

    const chunk = await readRangeContent(
      b.runtime,
      b.userId,
      create(ui.ThreadSyncContentRequestSchema, {
        threadId: moved,
        sha256: item!.content!.sha256,
        length: 1024,
      }),
    );

    expect(chunk.data.length).toBe(1024);
    expect(chunk.sizeBytes).toBe(item!.content!.sizeBytes);

    const rebuilt = await readThreadRange(
      source,
      create(ui.ThreadSyncCursorSchema, {
        threadId: moved,
        epoch: crypto.randomUUID(),
        appliedSeq: 999_999n,
      }),
    );

    expect(rebuilt.baseSeq).toBe(0n);
    expect(rebuilt.records[0]?.seq).toBe(1n);
    expect(rebuilt.epoch).toBe(cursor.epoch);
    await expect(
      readRangeContent(
        b.runtime,
        crypto.randomUUID(),
        create(ui.ThreadSyncContentRequestSchema, {
          threadId: moved,
          sha256: item!.content!.sha256,
          length: 1024,
        }),
      ),
    ).rejects.toThrow();
  }, 15_000);

  test("one deterministic watch failure stays scoped while other threads and unary work", async () => {
    const original = (await b.api.getThread({ threadId: thread })).thread!;

    const broken = (
      await b.api.createThread({
        projectId: original.projectId,
        workspaceId: original.workspaceId,
        provider: Provider.CODEX,
        title: "Failure isolation",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    await readThreadRange(source, create(ui.ThreadSyncCursorSchema, { threadId: broken }));
    await source.query(
      `WITH next AS (UPDATE thread_replication_clock SET head_seq=head_seq+1 WHERE thread_id=$1::uuid
      RETURNING epoch,head_seq) INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id,payload)
      SELECT $1::uuid,epoch,head_seq,'future','broken',decode('0f','hex') FROM next`,
      [broken],
    );
    expect(
      await eventually(
        async () =>
          (
            await target.query<{ reason: string }>(
              `SELECT reason FROM thread_range_failures
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid`,
              [a.userId, node, broken],
            )
          )[0]?.reason,
        (reason) => reason === "decode_error",
        10_000,
      ),
    ).toBe("decode_error");

    const failureAttempts = async () =>
      (
        await source.query<{ attempts: number }>(
          "SELECT attempts FROM thread_publication_failures WHERE thread_id=$1::uuid",
          [broken],
        )
      )[0]?.attempts;

    const attempts = await failureAttempts();
    expect(attempts).toBeGreaterThan(0);

    const clock = (
      await source.query<{ epoch: string }>(
        "SELECT epoch::text FROM thread_replication_clock WHERE thread_id=$1::uuid",
        [broken],
      )
    )[0]!;

    let watchFailure: ConnectError | undefined;

    try {
      for await (const _ of a.api.watchThread(
        {
          threadId: qualifyId(broken, node),
          sequence: true,
          syncCursor: { threadId: qualifyId(broken, node), epoch: clock.epoch, appliedSeq: 0n },
        },
        { timeoutMs: 5000 },
      )) {
        // The good prefix precedes the malformed sealed record.
      }
    } catch (cause) {
      watchFailure = ConnectError.from(cause);
    }

    expect(watchFailure?.code).toBe(Code.DataLoss);
    expect(watchFailure?.metadata.get("canopy-sync-reason")).toBe("decode_error");
    expect(watchFailure?.metadata.get("canopy-frame-bytes")).toBe("1");
    await b.api.updateThread({ threadId: thread, title: "Healthy beside a failed thread" });
    expect(
      await eventually(
        async () => (await local.mirror.thread(node, thread))?.title,
        (title) => title === "Healthy beside a failed thread",
        5000,
      ),
    ).toBe("Healthy beside a failed thread");
    expect((await b.api.getThread({ threadId: broken })).thread?.id).toBe(broken);
    expect(await failureAttempts()).toBe(attempts);
    expect((await local.computer(node))?.status).toBe("connected");

    const invalid = (
      await source.query<{ seq: string }>(
        `SELECT seq::text FROM thread_replication_journal
      WHERE thread_id=$1::uuid AND kind='future'`,
        [broken],
      )
    )[0]!;

    const repaired = create(ui.ThreadSyncRecordSchema, { seq: BigInt(invalid.seq), key: "future:broken" });
    await source.query(`UPDATE thread_replication_journal SET payload=$2 WHERE thread_id=$1::uuid AND kind='future'`, [
      broken,
      toBinary(ui.ThreadSyncRecordSchema, repaired),
    ]);
    await b.api.updateThread({ threadId: broken, title: "Recovered unknown record" });
    expect(
      await eventually(
        async () => {
          if (applyFailure) throw applyFailure;

          return (await local.mirror.thread(node, broken))?.title;
        },
        (title) => title === "Recovered unknown record",
        5000,
      ),
    ).toBe("Recovered unknown record");
    expect(
      await target.query(
        `SELECT 1 FROM thread_range_failures WHERE owner_user_id=$1::uuid
      AND origin_node_id=$2 AND thread_id=$3::uuid`,
        [a.userId, node, broken],
      ),
    ).toHaveLength(0);
  }, 20_000);

  async function range(cursor: ui.ThreadSyncCursor, throughSeq = 0n) {
    const method = link.ThreadMirrorService.method.getThreadRange;
    const request = create(link.ThreadRangeRequestSchema, { cursor, throughSeq });

    for await (const message of local.remote(node, method, request, AbortSignal.timeout(5000)))
      return linkedMessage(ui.ThreadSyncBatchSchema, message);
    throw new Error("Missing bounded range response");
  }
});
