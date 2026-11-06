import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("UI checkpoints over the real gateway", () => {
  let gw: TestGateway;
  let store: ComputerStore;
  let id: string;
  let base: ui.ThreadSnapshot;

  async function open(cursor = "", incremental = true) {
    const abort = new AbortController();

    try {
      for await (const update of gw.api.watchThread({ threadId: id, cursor, incremental }, { signal: abort.signal }))
        return update;
      throw new Error("Thread stream ended before its initial state");
    } finally {
      abort.abort();
    }
  }

  beforeAll(async () => {
    gw = await startTestGateway();
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
    const project = (await gw.api.createProject({ name: "UI history" })).project!.id;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project, workerId: gw.workerId, rootPath: "/repo/cache" })
    ).workspace!.id;

    id = (
      await gw.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Long thread",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const item = create(ItemSchema, {
      status: ItemStatus.COMPLETED,
      content: {
        case: "commandExecution",
        value: { command: "bun test", output: "tool output\n".repeat(100), exitCode: 0 },
      },
    });

    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-' || n,'command_execution','completed',$2::jsonb || jsonb_build_object('itemId','item-' || n),n,n
      FROM generate_series(1,3000) n`,
      [id, JSON.stringify(toJson(ItemSchema, item))],
    );
    await store.query("UPDATE threads SET last_seq=3000 WHERE id=$1::uuid", [id]);
    base = applyThreadUpdate(undefined, await open());
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("a caught-up UI receives metadata and a checkpoint without history", async () => {
    expect(base.items).toHaveLength(3000);
    expect(base.cursor).toMatch(/^[a-f0-9-]{36}:\d+$/);
    const update = await open(base.cursor);
    expect(update.change.case).toBe("delta");
    expect(toBinary(ui.ThreadUpdateSchema, update).length).toBeLessThan(4000);
    expect(applyThreadUpdate(base, update).items).toEqual(base.items);
  });

  test("upserts and tombstones reconstruct the same history as a fresh client", async () => {
    await store.query("DELETE FROM thread_items WHERE thread_id=$1::uuid AND item_id='item-3'", [id]);
    await store.query(
      `UPDATE thread_items SET content=jsonb_set(content,'{commandExecution,output}','"changed output"'::jsonb)
      WHERE thread_id=$1::uuid AND item_id='item-2'`,
      [id],
    );
    const update = await open(base.cursor);
    expect(update.change.case).toBe("delta");
    const next = applyThreadUpdate(base, update);
    const full = applyThreadUpdate(undefined, await open());
    expect(next).toEqual(full);
    expect(next.items).toHaveLength(2999);
    expect(next.items.find((i) => i.item?.itemId === "item-2")?.item?.content.value).toMatchObject({
      output: "changed output",
    });
    base = next;
  });

  test("old clients and malformed, future or other-epoch cursors receive full snapshots", async () => {
    for (const [cursor, incremental] of [
      [base.cursor, false],
      ["unknown", true],
      [`${crypto.randomUUID()}:0`, true],
      [`${base.cursor.split(":")[0]}:999999999999999`, true],
    ] as const) {
      const update = await open(cursor, incremental);
      expect(update.change.case).toBe("snapshot");
      expect(applyThreadUpdate(undefined, update).items).toHaveLength(2999);
    }
  });

  test("the same cursor survives a gateway restart", async () => {
    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage });
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
    expect((await open(base.cursor)).change.case).toBe("delta");
  }, 30_000);

  test("a gap and an epoch reset force full state instead of partial history", async () => {
    const cursor = applyThreadUpdate(undefined, await open()).cursor;
    await store.query("UPDATE threads SET title='After gap' WHERE id=$1::uuid", [id]);
    await store.query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid AND revision>$2::bigint", [
      gw.userId,
      cursor.split(":")[1],
    ]);
    expect((await open(cursor)).change.case).toBe("snapshot");
    await store.query("UPDATE computer_thread_clock SET epoch=gen_random_uuid() WHERE owner_user_id=$1::uuid", [
      gw.userId,
    ]);
    expect((await open(cursor)).change.case).toBe("snapshot");
  });

  test("a foreign-owner thread cannot be read even with a valid cursor", async () => {
    const foreign = crypto.randomUUID();
    await store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Foreign','user')", [
      foreign,
      `${foreign}@test.invalid`,
    ]);
    const foreignThread = crypto.randomUUID();
    await store.query(
      `INSERT INTO threads(id,root_thread_id,owner_user_id,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status)
      SELECT $1::uuid,$1::uuid,$2::uuid,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status
      FROM threads WHERE id=$3::uuid`,
      [foreignThread, foreign, id],
    );
    await expect(
      gw.api
        .watchThread(
          { threadId: foreignThread, cursor: base.cursor, incremental: true },
          { signal: AbortSignal.timeout(3000) },
        )
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow();
  });
});
