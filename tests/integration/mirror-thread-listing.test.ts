import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { ThreadMirror } from "../../apps/gateway/src/computers/mirror.ts";
import { splitStatements } from "../../packages/db/src/migrations/split.ts";
import backfill from "../../packages/db/src/migrations/0097_mirror_thread_metadata.sql" with { type: "text" };
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("mirror metadata listing and backfill", () => {
  let gateway: TestGateway;
  let store: ComputerStore;
  let mirror: ThreadMirror;
  const node = "a".repeat(64);
  const generation = crypto.randomUUID();
  const project = crypto.randomUUID();
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());

  beforeAll(async () => {
    gateway = await startTestGateway();
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    mirror = new ThreadMirror(store);
    await store.query(
      `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,app_version,min_protocol,max_protocol)
      VALUES($1::uuid,$2,'Peer','test','test','test',1,1)`,
      [gateway.userId, node],
    );
    await store.query(
      "INSERT INTO computer_mirror_state(owner_user_id,origin_node_id,generation) VALUES($1::uuid,$2,$3::uuid)",
      [gateway.userId, node, generation],
    );

    for (const [index, id] of ids.entries()) {
      const thread = create(ui.ThreadSchema, {
        id,
        projectId: project,
        title: `Thread ${index}`,
        status: index === 0 ? "archived" : "idle",
      });

      const snapshot = toBinary(ui.ThreadSnapshotSchema, create(ui.ThreadSnapshotSchema, { thread }));

      await store.query(
        `INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
        VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$6)`,
        [gateway.userId, node, generation, id, snapshot, toBinary(ui.ThreadSchema, thread)],
      );
    }
  }, 30_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("listing uses only owned metadata even when snapshots cannot be decoded", async () => {
    await store.query(
      `UPDATE computer_mirror_threads
      SET snapshot=CASE WHEN thread_id=$3::uuid THEN repeat('x',17*1024*1024)::bytea ELSE $4 END
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2`,
      [gateway.userId, node, ids[0]!, new Uint8Array([0xff])],
    );

    const list = (options: { includeArchived?: boolean; projectId?: string } = {}) =>
      mirror.threads(node, create(ui.ListThreadsRequestSchema, options));

    expect((await list({ includeArchived: true })).map((thread) => thread.id).sort()).toEqual(
      ids.map((id) => qualifyId(id, node)).sort(),
    );
    expect((await list()).map((thread) => thread.id).sort()).toEqual(
      ids
        .slice(1)
        .map((id) => qualifyId(id, node))
        .sort(),
    );
    expect(await list({ projectId: crypto.randomUUID() })).toEqual([]);
    const other = new ThreadMirror(new ComputerStore(gateway.runtime, crypto.randomUUID(), gateway.secretsKey));
    expect(await other.threads(node, create(ui.ListThreadsRequestSchema))).toEqual([]);
  });

  test("backfill extracts the header even after a history field and enforces non-null metadata", async () => {
    const thread = create(ui.ThreadSchema, {
      id: ids[0]!,
      projectId: project,
      title: "Preserved header",
      status: "idle",
    });

    const header = toBinary(ui.ThreadSnapshotSchema, create(ui.ThreadSnapshotSchema, { thread }));

    const history = toBinary(
      ui.ThreadSnapshotSchema,
      create(ui.ThreadSnapshotSchema, { notices: [{ notice: { message: "Older history" } }] }),
    );

    const snapshot = new Uint8Array([...history, ...header]);
    await store.query("ALTER TABLE computer_mirror_threads ALTER COLUMN thread_metadata DROP NOT NULL");
    await store.query(
      "UPDATE computer_mirror_threads SET snapshot=$3,thread_metadata=NULL WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
      [gateway.userId, node, snapshot],
    );

    for (const statement of splitStatements(backfill)) await store.query(statement);

    expect((await mirror.thread(node, ids[0]!))?.title).toBe("Preserved header");
    expect(await mirror.threads(node, create(ui.ListThreadsRequestSchema))).toHaveLength(ids.length);
    await expect(
      store.query(
        "UPDATE computer_mirror_threads SET thread_metadata=NULL WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
        [gateway.userId, node],
      ),
    ).rejects.toBeDefined();
  });
});
