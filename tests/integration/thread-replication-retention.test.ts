import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { validateThreadBatch } from "@canopy/domain/thread-sync";
import { Code } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { readClientWindow } from "../../apps/gateway/src/core/client-window.ts";
import { SequenceWindow } from "../../apps/gateway/src/core/sequence-window.ts";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { pruneThreadReplication } from "../../apps/gateway/src/maintenance/thread-replication.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const before = "2000-01-01T00:00:00Z";

describe.skipIf(!dockerAvailable)("bounded source thread replication", () => {
  let gateway: TestGateway;
  let store: ComputerStore;

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
  });
  afterAll(async () => gateway?.close());

  async function thread({ checkpoint = true } = {}) {
    const project = (await gateway.api.createProject({ name: "Replication retention" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project,
        workerId: gateway.workerId,
        rootPath: "/repo/retention",
      })
    ).workspace!.id;

    const id = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Retained source",
      })
    ).thread!.id;

    await eventually(
      () => gateway.api.getThread({ threadId: id }),
      (value) => value.thread?.status === "idle",
    );

    if (checkpoint)
      await readClientWindow(store, create(ui.WatchThreadRequestSchema, { threadId: id, sequence: true }));

    return id;
  }

  async function watchSnapshot(input: MessageInitShape<typeof ui.WatchThreadRequestSchema>) {
    for await (const update of gateway.api.watchThread({ ...input, sequence: true }, { timeoutMs: 5000 })) {
      if (update.change.case === "snapshot") return update.change.value;
    }

    throw new Error("Sequence watch ended before sending a snapshot");
  }

  async function runMaintenance() {
    await store.query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [
      gateway.userId,
    ]);

    return gateway.runtime.runPromise(pruneDatabase(gateway.userId));
  }

  async function prune(id: string, owner = gateway.userId) {
    await store.query(
      `UPDATE thread_replication_clock SET retention_checked_at=CASE WHEN thread_id=$1::uuid
      THEN 'epoch'::timestamptz ELSE now() END WHERE owner_user_id=$2::uuid`,
      [id, owner],
    );

    return gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(pruneThreadReplication(sql, owner));
      }),
    );
  }

  async function age(id: string) {
    await store.query("UPDATE thread_replication_journal SET created_at=$2 WHERE thread_id=$1", [id, before]);
    await store.query("UPDATE thread_replication_content SET last_referenced_at=$2 WHERE thread_id=$1", [id, before]);
    await store.query("UPDATE thread_replication_content_leases SET lease_until=$2 WHERE thread_id=$1", [id, before]);
    await store.query("UPDATE thread_replication_snapshot_generations SET lease_until=$2 WHERE thread_id=$1", [
      id,
      before,
    ]);
  }

  async function history(id: string, count: number) {
    await store.query("DELETE FROM thread_replication_journal WHERE thread_id=$1", [id]);

    const encoded = Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      payload: Buffer.from(
        toBinary(
          ui.ThreadSyncRecordSchema,
          create(ui.ThreadSyncRecordSchema, {
            seq: BigInt(index + 1),
            key: `item:expired-${index}`,
            removed: true,
          }),
        ),
      ).toString("base64"),
    }));

    await store.query(
      `INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id,payload,content_indexed)
      SELECT c.thread_id,c.epoch,p.seq,'item','expired-'||(p.seq-1),decode(p.payload,'base64'),true
      FROM thread_replication_clock c CROSS JOIN jsonb_to_recordset($2::jsonb) p(seq bigint,payload text)
      WHERE c.thread_id=$1::uuid`,
      [id, JSON.stringify(encoded)],
    );
    await store.query("UPDATE thread_replication_clock SET head_seq=$2,checkpoint_seq=$2 WHERE thread_id=$1", [
      id,
      count,
    ]);
  }

  test("an old unpublished bootstrap prefix expires while snapshot references and reconnects still work", async () => {
    const id = await thread({ checkpoint: false });
    const output = "leased bootstrap output ".repeat(1500);
    // Build the source history before its first sequence watch. Bootstrap must
    // allocate the journal itself, leaving the header and item rows unsealed.
    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,items.id,'command_execution','completed',jsonb_build_object('itemId',items.id,
        'status','COMPLETED','commandExecution',jsonb_build_object('command','test','output',items.output)),items.n,items.n
      FROM (SELECT 'item-'||n AS id,'inline' AS output,n FROM generate_series(1,10000) n
        UNION ALL SELECT 'a-output',$2,10001) items`,
      [id, output],
    );
    const initial = await watchSnapshot({ threadId: id, targetItemId: "a-output", pageSize: 1 });
    const cursor = initial.syncCursor!;
    const hash = initial.items.find((item) => item.item?.itemId === "a-output")!.contentRef!.sha256;
    expect(cursor.appliedSeq).toBe(10_002n);
    expect(
      await store.query(
        `SELECT kind,payload IS NULL AS pending FROM thread_replication_journal
        WHERE thread_id=$1 AND epoch=$2 AND seq<=2 ORDER BY seq`,
        [id, cursor.epoch],
      ),
    ).toEqual([
      { kind: "thread", pending: true },
      { kind: "item", pending: true },
    ]);

    await gateway.api.updateThread({ threadId: id, title: "Current source" });
    await store.query(
      `UPDATE thread_items SET content=jsonb_set(content,'{commandExecution,output}','"Current output"')
      WHERE thread_id=$1 AND item_id='a-output'`,
      [id],
    );
    await store.query("UPDATE thread_replication_journal SET created_at=$2 WHERE thread_id=$1", [id, before]);
    await store.query("UPDATE thread_replication_content SET last_referenced_at=$2 WHERE thread_id=$1", [id, before]);
    expect(await store.query("SELECT 1 FROM thread_replication_entity_content WHERE thread_id=$1", [id])).toHaveLength(
      0,
    );
    await runMaintenance();
    expect(
      await store.query(
        `SELECT c.replay_floor_seq::int AS floor,min(j.seq)::int AS first,count(*)::int AS total
        FROM thread_replication_clock c JOIN thread_replication_journal j USING(thread_id,epoch)
        WHERE c.thread_id=$1 AND c.epoch=$2 GROUP BY c.replay_floor_seq`,
        [id, cursor.epoch],
      ),
    ).toEqual([{ floor: 4, first: 5, total: 10_000 }]);
    const content = await gateway.api.getThreadSyncContent({ threadId: id, sha256: hash });
    expect(Buffer.from(content.data).toString()).toContain("leased bootstrap output");

    const floor = create(ui.ThreadSyncCursorSchema, { ...cursor, appliedSeq: 4n });
    const replay = await readThreadRange(store, floor);
    expect(replay.epoch).toBe(cursor.epoch);
    validateThreadBatch(replay, floor.appliedSeq);
    expect(replay.records[0]?.seq).toBe(5n);

    const expired = create(ui.ThreadSyncCursorSchema, { ...cursor, appliedSeq: 0n });
    const window = await watchSnapshot({ threadId: id, syncCursor: expired, pageSize: 1 });
    expect(window.thread?.title).toBe("Current source");
    expect(window.syncCursor?.epoch).toBe(cursor.epoch);
    expect(window.syncCursor?.appliedSeq).toBe(10_004n);

    const reseed = await readThreadRange(store, expired);
    expect(reseed.epoch).not.toBe(cursor.epoch);
    validateThreadBatch(reseed, 0n);
    const [header, item] = reseed.records;
    expect(header?.value.case === "thread" && header.value.value.title).toBe("Current source");
    const command = item?.value.case === "item" && item.value.value.item?.content;
    expect(command && command.case === "commandExecution" && command.value.output).toBe("Current output");

    await age(id);
    await runMaintenance();
    await expect(gateway.api.getThreadSyncContent({ threadId: id, sha256: hash })).rejects.toMatchObject({
      code: Code.NotFound,
    });
  }, 30_000);

  test("10k suffix converges in bounded batches after grace and isolates owners", async () => {
    const id = await thread();
    await history(id, 12_512);
    await store.query(
      `INSERT INTO thread_replication_content(thread_id,sha256,data)
      SELECT $1::uuid,encode(sha256(convert_to(n::text,'UTF8')),'hex'),
        decode(repeat(md5(n::text),2048),'hex') FROM generate_series(1,512) n`,
      [id],
    );
    expect(await prune(id)).toBe(0);
    await age(id);
    await store.query(
      `UPDATE thread_replication_journal SET payload=NULL,content_indexed=false,created_at=now()
      WHERE thread_id=$1 AND seq=200`,
      [id],
    );
    expect(await prune(id, crypto.randomUUID())).toBe(0);
    await prune(id);
    expect(
      await store.query("SELECT replay_floor_seq::int AS floor FROM thread_replication_clock WHERE thread_id=$1", [id]),
    ).toEqual([{ floor: 199 }]);
    await store.query("UPDATE thread_replication_journal SET created_at=$2 WHERE thread_id=$1 AND seq=200", [
      id,
      before,
    ]);
    const maximum: number[] = [];

    for (let index = 0; index < 12; index++) {
      const prior = (
        await store.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM thread_replication_journal WHERE thread_id=$1",
          [id],
        )
      )[0]!.n;

      await prune(id);

      const after = (
        await store.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM thread_replication_journal WHERE thread_id=$1",
          [id],
        )
      )[0]!.n;

      maximum.push(prior - after);
    }

    const clock = (
      await store.query<{ epoch: string; floor: string }>(
        `SELECT epoch,replay_floor_seq::text AS floor
      FROM thread_replication_clock WHERE thread_id=$1`,
        [id],
      )
    )[0]!;

    expect(clock.floor).toBe("2512");
    expect(await store.query("SELECT 1 FROM thread_replication_content WHERE thread_id=$1", [id])).toHaveLength(0);
    expect(Math.max(...maximum)).toBeLessThanOrEqual(256);
    const cursor = create(ui.ThreadSyncCursorSchema, { threadId: id, epoch: clock.epoch, appliedSeq: 2512n });
    const range = await readThreadRange(store, cursor);
    validateThreadBatch(range, 2512n);
    expect(range.records[0]?.seq).toBe(2513n);
    console.info("Replication retention bounds", {
      journalBefore: 12_512,
      journalAfter: 10_000,
      maxJournalDeletedPerPass: Math.max(...maximum),
      orphanContentBeforeBytes: 512 * 32_768,
      orphanContentAfterBytes: 0,
    });
  }, 20_000);

  test("issued snapshot hashes survive supersession, expiry and cached republication", async () => {
    const id = await thread();
    const text = "snapshot tool output ".repeat(3000);
    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES($1,'output','command_execution','completed',$2::jsonb,1,1)`,
      [
        id,
        JSON.stringify({
          itemId: "output",
          status: "COMPLETED",
          commandExecution: { command: "test", output: text },
        }),
      ],
    );
    const window = new SequenceWindow(store);
    const input = create(ui.WatchThreadRequestSchema, { threadId: id, sequence: true });
    const snapshot = await window.read(input);
    const hash = snapshot.items.find((item) => item.item?.itemId === "output")!.contentRef!.sha256;
    await store.query("DELETE FROM thread_replication_content WHERE thread_id=$1 AND sha256=$2", [id, hash]);
    const rebuilt = await window.read(input);
    expect(rebuilt.items.find((item) => item.item?.itemId === "output")!.contentRef!.sha256).toBe(hash);
    await age(id);
    await window.read(input);
    await store.query("UPDATE thread_replication_content SET last_referenced_at=$2 WHERE thread_id=$1", [id, before]);
    await prune(id);
    const chunk = await gateway.api.getThreadSyncContent({ threadId: id, sha256: hash });
    expect(Buffer.from(chunk.data).toString()).toContain("snapshot tool output");
    await store.query(
      `UPDATE thread_items SET content=jsonb_set(content,'{commandExecution,output}','"new"') WHERE thread_id=$1`,
      [id],
    );
    await age(id);
    await prune(id);
    await expect(gateway.api.getThreadSyncContent({ threadId: id, sha256: hash })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    window.close();
  });

  test("active catch-up pins a prefix; expired offline cursors rebuild, genuine suffix gaps still fail", async () => {
    const id = await thread();
    await history(id, 10_400);

    const old = (
      await store.query<{ epoch: string }>("SELECT epoch FROM thread_replication_clock WHERE thread_id=$1", [id])
    )[0]!.epoch;

    const cursor = create(ui.ThreadSyncCursorSchema, { threadId: id, epoch: old, appliedSeq: 10n });
    const generation = crypto.randomUUID();
    const first = await readThreadRange(store, cursor, 0n, generation);
    validateThreadBatch(first, 10n);
    const pending = first.appliedSeq + 1n;
    await store.query(
      `UPDATE thread_replication_journal SET payload=NULL,content_indexed=false WHERE thread_id=$1 AND seq=$2`,
      [id, pending.toString()],
    );
    await store.query("UPDATE thread_replication_journal SET created_at=$2 WHERE thread_id=$1", [id, before]);
    await prune(id);
    expect(
      (
        await store.query<{ floor: string }>(
          "SELECT replay_floor_seq::text AS floor FROM thread_replication_clock WHERE thread_id=$1",
          [id],
        )
      )[0]!.floor,
    ).toBe("10");
    await age(id);
    await prune(id);

    const suffix = (
      await store.query<{ floor: string }>(
        "SELECT replay_floor_seq::text AS floor FROM thread_replication_clock WHERE thread_id=$1",
        [id],
      )
    )[0]!.floor;

    expect(BigInt(suffix)).toBeGreaterThanOrEqual(pending);
    const snapshot = await watchSnapshot({ threadId: id, syncCursor: cursor });
    expect(snapshot.thread?.title).toBe("Retained source");
    expect(snapshot.syncCursor?.epoch).toBe(old);
    const reset = await readThreadRange(store, cursor);
    expect(reset.epoch).not.toBe(old);
    validateThreadBatch(reset, 0n);
    expect(reset.records.some((record) => record.value.case === "thread")).toBe(true);
    expect(
      (
        await store.query<{ floor: string }>(
          "SELECT replay_floor_seq::text AS floor FROM thread_replication_clock WHERE thread_id=$1",
          [id],
        )
      )[0]!.floor,
    ).toBe("0");
    await history(id, 10_004);
    await store.query("DELETE FROM thread_replication_journal WHERE thread_id=$1 AND seq=2", [id]);
    await age(id);
    await prune(id);
    expect(
      await store.query("SELECT replay_floor_seq::int AS floor FROM thread_replication_clock WHERE thread_id=$1", [id]),
    ).toEqual([{ floor: 1 }]);
    await expect(
      readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: id, epoch: reset.epoch, appliedSeq: 1n })),
    ).rejects.toMatchObject({ code: Code.DataLoss });
  });

  test("content leases and replay floor survive a gateway restart", async () => {
    const id = await thread();
    await history(id, 10_300);
    await age(id);
    await prune(id);

    const epoch = (
      await store.query<{ epoch: string }>("SELECT epoch FROM thread_replication_clock WHERE thread_id=$1", [id])
    )[0]!.epoch;

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ role: "desktop", storage });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);

    const resumed = await readThreadRange(
      store,
      create(ui.ThreadSyncCursorSchema, { threadId: id, epoch, appliedSeq: 256n }),
    );

    validateThreadBatch(resumed, 256n);
    expect(resumed.records[0]?.seq).toBe(257n);
  }, 20_000);
});
