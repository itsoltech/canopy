import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { retainCurrentContent } from "../../apps/gateway/src/computers/range-leases.ts";
import { readClientWindow } from "../../apps/gateway/src/core/client-window.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("sequence replay of repeated lazy entities", () => {
  let gateway: TestGateway;
  let store: ComputerStore;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    projectId = (await gateway.api.createProject({ name: "Lazy replay" })).project!.id;
    workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/lazy-replay" })
    ).workspace!.id;
  });
  afterAll(async () => gateway?.close());

  async function thread() {
    const id = (await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
    await eventually(
      () => gateway.api.getThread({ threadId: id }),
      (result) => result.thread?.status === "idle",
    );
    gateway.worker.emit(id, "", {
      case: "itemStarted",
      value: {
        item: {
          itemId: "output",
          status: ItemStatus.IN_PROGRESS,
          content: { case: "commandExecution", value: { command: "test", output: "" } },
        },
      },
    });
    await outputLength(id, 0);

    return id;
  }

  function window(id: string) {
    return readClientWindow(store, create(ui.WatchThreadRequestSchema, { threadId: id, sequence: true }));
  }

  async function outputLength(id: string, length: number) {
    expect(
      await eventually(
        async () =>
          (
            await store.query<{ size: number }>(
              `SELECT length(coalesce(content->'commandExecution'->>'output','')) AS size
              FROM thread_items WHERE thread_id=$1::uuid AND item_id='output'`,
              [id],
            )
          )[0]?.size,
        (size) => size === length,
      ),
    ).toBe(length);
  }

  async function append(id: string, chunk: string, length: number) {
    gateway.worker.emit(id, "", {
      case: "itemDelta",
      value: { itemId: "output", field: ItemDeltaField.OUTPUT, chunk },
    });
    await outputLength(id, length);
  }

  async function resume(base: ui.ThreadSnapshot) {
    const abort = new AbortController();
    let state = base;

    try {
      for await (const update of gateway.api.watchThread(
        { threadId: base.thread!.id, sequence: true, syncCursor: base.syncCursor },
        { signal: abort.signal, timeoutMs: 5000 },
      )) {
        expect(update.change.case).not.toBe("snapshot");
        state = applyThreadUpdate(state, update);

        if (update.change.case === "batch" && update.change.value.caughtUp) return state;
      }

      throw new Error("Replay ended before catching up");
    } finally {
      abort.abort();
    }
  }

  test("a disconnected viewer replays duplicate pending revisions across another viewer's checkpoint", async () => {
    const id = await thread();
    const base = await window(id);
    await append(id, "a".repeat(30_000), 30_000);
    const middle = await window(id);
    expect(middle.items[0]?.contentRef?.sha256).toBeTruthy();
    await append(id, "b".repeat(1000), 31_000);

    const pending = await store.query<{ seq: string }>(
      `SELECT seq::text FROM thread_replication_journal WHERE thread_id=$1::uuid
        AND epoch=$2::uuid AND kind='item' AND entity_id='output' AND payload IS NULL AND seq>$3::bigint
        ORDER BY seq`,
      [id, base.syncCursor!.epoch, base.syncCursor!.appliedSeq.toString()],
    );

    expect(pending).toHaveLength(2);
    const state = await resume(base);
    expect(state.syncCursor!.appliedSeq).toBeGreaterThan(middle.syncCursor!.appliedSeq);
    const hash = state.items.find((item) => item.item?.itemId === "output")!.contentRef!.sha256;

    const pointers = await store.query<{ sha256: string; seq: string }>(
      "SELECT sha256,seq::text FROM thread_replication_entity_content WHERE thread_id=$1::uuid AND entity_key='item:output'",
      [id],
    );

    expect(pointers).toEqual([{ sha256: hash, seq: pending.at(-1)!.seq }]);
    const chunk = await gateway.api.getThreadSyncContent({ threadId: id, sha256: hash });
    expect(Buffer.from(chunk.data).toString()).toContain("b".repeat(1000));
  }, 15_000);

  test("current content follows the highest revision including inline replacements and removals", async () => {
    const id = await thread();
    await window(id);
    const hashes = ["a".repeat(64), "b".repeat(64)];
    await store.query(
      `INSERT INTO thread_replication_content(thread_id,sha256,data)
      SELECT $1::uuid,hash,decode('00','hex') FROM unnest($2::text[]) hash`,
      [id, hashes],
    );

    const record = (key: string, seq: bigint, hash?: string, removed = false) =>
      create(ui.ThreadSyncRecordSchema, {
        key,
        seq,
        removed,
        ...(hash && { content: { sha256: hash } }),
      });

    const retain = (records: ui.ThreadSyncRecord[]) =>
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(retainCurrentContent(sql, id, records));
        }),
      );

    await retain([record("item:inline", 10n, hashes[0]), record("item:removed", 10n, hashes[0])]);
    await retain([
      record("item:inline", 30n),
      record("item:inline", 20n, hashes[1]),
      record("item:removed", 30n, hashes[1], true),
      record("item:removed", 20n, hashes[1]),
      record("item:latest", 30n, hashes[1]),
      record("item:latest", 20n, hashes[0]),
    ]);
    await retain([record("item:latest", 10n, hashes[0]), record("item:latest", 20n, undefined, true)]);
    expect(
      await store.query<{ entity_key: string; sha256: string; seq: string }>(
        "SELECT entity_key,sha256,seq::text FROM thread_replication_entity_content WHERE thread_id=$1::uuid",
        [id],
      ),
    ).toEqual([{ entity_key: "item:latest", sha256: hashes[1]!, seq: "30" }]);
  });
});
