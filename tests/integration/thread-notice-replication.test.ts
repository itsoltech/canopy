import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { validateThreadBatch } from "@canopy/domain/thread-sync";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("worker transcript notice replication", () => {
  let gateway: TestGateway;
  let store: ComputerStore;

  beforeAll(async () => {
    gateway = await startTestGateway();
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
  });
  afterAll(async () => gateway?.close());

  test("token ingest keeps stream items, turns and headers without phantom notices", async () => {
    const project = (await gateway.api.createProject({ name: "Notice replication" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project.id,
        workerId: gateway.workerId,
        rootPath: "/repo/notices",
      })
    ).workspace!;

    const thread = (
      await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!.id;

    await eventually(
      () => gateway.api.getThread({ threadId: thread }),
      (value) => value.thread?.status === "idle",
    );
    const initial = await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));

    const cursor = create(ui.ThreadSyncCursorSchema, {
      threadId: thread,
      epoch: initial.epoch,
      appliedSeq: initial.appliedSeq,
    });

    gateway.worker.holdTurns = true;

    const turn = (
      await gateway.api.sendMessage({
        threadId: thread,
        text: "Stream a response",
        clientRequestId: crypto.randomUUID(),
      })
    ).turn!.id;

    await eventually(
      () => store.query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turn]),
      (rows) => rows[0]?.status === "running",
    );
    gateway.worker.emit(thread, turn, {
      case: "itemStarted",
      value: {
        item: {
          itemId: "tokens",
          status: ItemStatus.IN_PROGRESS,
          content: { case: "agentMessage", value: { text: "" } },
        },
      },
    });

    for (let index = 0; index < 24; index++)
      gateway.worker.emit(thread, turn, {
        case: "itemDelta",
        value: { itemId: "tokens", field: ItemDeltaField.TEXT, chunk: "token " },
      });
    gateway.worker.emit(thread, turn, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: "tokens",
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text: "token ".repeat(24) } },
        },
      },
    });
    gateway.worker.emit(thread, turn, { case: "notice", value: { code: "replication_test", message: "Real notice" } });
    gateway.worker.finish(thread, turn);
    await eventually(
      () => store.query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turn]),
      (rows) => rows[0]?.status === "completed",
    );

    const records: ui.ThreadSyncRecord[] = [];
    let applied = cursor.appliedSeq;

    for await (const update of gateway.api.watchThread(
      { threadId: thread, sequence: true, syncCursor: cursor },
      { timeoutMs: 5000 },
    )) {
      if (update.change.case !== "batch") continue;
      const batch = update.change.value;
      validateThreadBatch(batch, applied);
      records.push(...batch.records);
      applied = batch.appliedSeq;

      if (batch.caughtUp) break;
    }

    const events = await store.query<{ seq: string }>(
      "SELECT seq::text FROM thread_events WHERE thread_id=$1::uuid AND kind='notice' ORDER BY seq",
      [thread],
    );

    expect(events).toHaveLength(1);
    expect(records.flatMap((record) => (record.key.startsWith("notice:") ? [record.key] : []))).toEqual(
      events.map((row) => `notice:${row.seq}`),
    );
    expect(records.some((record) => record.removed)).toBe(false);
    expect(
      records.some(
        (record) => record.value.case === "notice" && record.value.value.notice?.code === "replication_test",
      ),
    ).toBe(true);

    const item = records.findLast(
      (record) => record.value.case === "item" && record.value.value.item?.itemId === "tokens",
    )?.value;

    expect(
      item?.case === "item" && item.value.item?.content.case === "agentMessage" && item.value.item.content.value.text,
    ).toBe("token ".repeat(24));
    expect(
      records.some(
        (record) =>
          record.value.case === "turn" && record.value.value.id === turn && record.value.value.status === "completed",
      ),
    ).toBe(true);
    const header = records.findLast((record) => record.value.case === "thread")?.value;
    const current = (await gateway.api.getThread({ threadId: thread })).thread!;
    expect(header?.case === "thread" && header.value.lastSeq).toBe(current.lastSeq);
    expect(header?.case === "thread" && header.value.status).toBe("idle");
    expect(
      await store.query(
        "SELECT 1 FROM computer_thread_changes WHERE thread_id=$1::uuid AND entity_kind='thread_items'",
        [thread],
      ),
    ).not.toHaveLength(0);
    expect(
      await store.query(
        "SELECT entity_id FROM computer_thread_changes WHERE thread_id=$1::uuid AND entity_kind='thread_events'",
        [thread],
      ),
    ).toEqual(events.map((row) => ({ entity_id: row.seq })));

    await store.query("DELETE FROM thread_events WHERE thread_id=$1::uuid AND kind='notice'", [thread]);
    const deleted = await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { ...cursor, appliedSeq: applied }));
    validateThreadBatch(deleted, applied);
    expect(
      deleted.records.flatMap((record) =>
        record.key.startsWith("notice:") ? [{ key: record.key, removed: record.removed }] : [],
      ),
    ).toEqual([{ key: `notice:${events[0]!.seq}`, removed: true }]);
  }, 15_000);
});
