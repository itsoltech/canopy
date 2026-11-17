import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { writeRangeEntities } from "../../apps/gateway/src/computers/range-entities.ts";
import { readRangeMirror } from "../../apps/gateway/src/computers/range-read.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded mirror windows retain steer attribution", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let store: ComputerStore;
  const node = "c".repeat(64);
  const thread = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const turn = crypto.randomUUID();
  const sender = crypto.randomUUID();

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    await store.query(
      `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES($1::uuid,$2,'Steer history','unused','unused')`,
      [gateway.userId, node],
    );
    await store.query("INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES($1::uuid,$2)", [
      gateway.userId,
      node,
    ]);
    await store.query(
      `INSERT INTO thread_range_state(owner_user_id,origin_node_id,thread_id,epoch,visible_epoch,
      applied_seq,head_seq,visible_applied_seq,subscription_id)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$4::uuid,10000,10000,10000,gen_random_uuid())`,
      [gateway.userId, node, thread, epoch],
    );
  });

  afterAll(async () => {
    await gateway?.close();
  });

  async function save(records: ui.ThreadSyncRecord[], savedEpoch = epoch, savedThread = thread) {
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* writeRangeEntities(
          sql,
          gateway.userId,
          node,
          create(ui.ThreadSyncBatchSchema, { threadId: savedThread, epoch: savedEpoch, records }),
        );
      }),
    );
  }

  function steer(id: string, key = `steer:${id}`, text = "An agent follow-up") {
    return create(ui.ThreadSyncRecordSchema, {
      key,
      seq: 1n,
      value: {
        case: "steer",
        value: {
          id,
          threadId: thread,
          turnId: turn,
          status: "delivered",
          text,
          sourceThreadId: sender,
          sender: { threadId: sender, title: "History author", provider: Provider.CODEX, model: "test-model" },
        },
      },
    });
  }

  function item(position: number, clientId = "", text = "Saved message") {
    return create(ui.ThreadSyncRecordSchema, {
      key: `item:item-${position}`,
      seq: BigInt(position + 10),
      position: BigInt(position),
      value: {
        case: "item",
        value: {
          turnId: turn,
          firstSeq: BigInt(position),
          lastSeq: BigInt(position),
          item: {
            itemId: `item-${position}`,
            content: clientId
              ? { case: "userMessage", value: { clientId, text } }
              : { case: "agentMessage", value: { text } },
          },
        },
      },
    });
  }

  test("older pages resolve exact normal and moved steer records beyond recent metadata", async () => {
    const old = crypto.randomUUID();
    const moved = crypto.randomUUID();
    const recent = crypto.randomUUID();

    const clients = new Map([
      [0, old],
      [1, moved],
      [149, recent],
    ]);

    await save([
      create(ui.ThreadSyncRecordSchema, {
        key: `turn:${turn}`,
        position: 1n,
        value: { case: "turn", value: { id: turn, ordinal: 1, status: "completed" } },
      }),
      steer(old),
      steer(moved, `legacy_steer:${moved}`),
      { ...steer(recent), seq: 10000n },
      ...Array.from({ length: 150 }, (_, index) => item(index + 1, clients.get(index) ?? "")),
      ...Array.from({ length: 300 }, (_, index) =>
        create(ui.ThreadSyncRecordSchema, {
          key: `notice:${index}`,
          seq: BigInt(index + 1000),
          value: { case: "notice", value: { seq: BigInt(index + 1000), message: "n".repeat(300) } },
        }),
      ),
    ]);
    const latest = (await readRangeMirror(store, node, thread))!.snapshot;
    expect(latest.items).toHaveLength(128);
    expect(latest.steers.map((record) => record.id)).toEqual([qualifyId(recent, node)]);

    const older = (await readRangeMirror(store, node, thread, {
      beforeItemId: latest.historyBeforeItemId,
      beforeTurnId: latest.historyBeforeTurnId,
      historyVersion: latest.historyVersion,
    }))!.snapshot;

    expect(older.items).toHaveLength(22);

    for (const id of [old, moved]) {
      const record = older.steers.find((entry) => entry.id === qualifyId(id, node));
      expect(record?.sourceThreadId).toBe(qualifyId(sender, node));
      expect(record?.sender?.model).toBe("test-model");
      expect(older.steers.filter((entry) => entry.id === qualifyId(id, node))).toHaveLength(1);
    }

    expect(older.historyItemsHasMore).toBe(false);
    expect(older.cursor).toBe(latest.cursor);
  });

  test("the item budget includes each steer once and stops at the first item that cannot fit", async () => {
    await store.query(
      "DELETE FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
      [gateway.userId, node, thread],
    );
    const shared = crypto.randomUUID();
    const blocked = crypto.randomUUID();

    await save([
      item(1),
      item(2, blocked, "x".repeat(100 * 1024)),
      item(3, shared, "x".repeat(100 * 1024)),
      item(4, shared, "x".repeat(100 * 1024)),
      steer(shared, `steer:${shared}`, "s".repeat(100 * 1024)),
      steer(blocked, `steer:${blocked}`, "b".repeat(20 * 1024)),
    ]);
    const snapshot = (await readRangeMirror(store, node, thread))!.snapshot;
    expect(snapshot.items.map((entry) => entry.item?.itemId)).toEqual(["item-3", "item-4"]);
    expect(snapshot.steers.map((entry) => entry.id)).toEqual([qualifyId(shared, node)]);
    expect(snapshot.historyItemsHasMore).toBe(true);
    expect(snapshot.historyBeforeItemId).toBe("item-3");
    expect(toBinary(ui.ThreadSnapshotSchema, snapshot).length).toBeLessThanOrEqual(512 * 1024);

    const older = (await readRangeMirror(store, node, thread, { beforeItemId: snapshot.historyBeforeItemId }))!
      .snapshot;

    expect(older.items.map((entry) => entry.item?.itemId)).toEqual(["item-1", "item-2"]);
    expect(older.steers.map((entry) => entry.id)).toEqual([qualifyId(blocked, node)]);
    expect(older.historyItemsHasMore).toBe(false);
  });

  test("dependency lookup ignores matching steer keys from a different epoch", async () => {
    await store.query(
      "DELETE FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
      [gateway.userId, node, thread],
    );
    const absent = crypto.randomUUID();
    await save([item(1, absent)]);
    await save([steer(absent, `steer:${absent}`, "Other epoch")], crypto.randomUUID());
    const snapshot = (await readRangeMirror(store, node, thread))!.snapshot;
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.steers).toHaveLength(0);
  });
});
