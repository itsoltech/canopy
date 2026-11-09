import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
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
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());

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
    const text = "x".repeat(3 * 1024 * 1024);

    for (const [index, id] of ids.entries()) {
      const thread = create(ui.ThreadSchema, {
        id,
        projectId: project,
        title: `Thread ${index}`,
        status: index === 0 ? "archived" : "idle",
      });

      const snapshot = toBinary(
        ui.ThreadSnapshotSchema,
        create(ui.ThreadSnapshotSchema, { thread, notices: [{ notice: { message: text } }] }),
      );

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

  test("100 three-MiB histories list only metadata, including with unreadable snapshots", async () => {
    const started = performance.now();

    const legacy = await store.query<{ snapshot: Uint8Array }>(
      `SELECT t.snapshot FROM computer_mirror_threads t
      JOIN computer_mirror_state s USING(owner_user_id,origin_node_id,generation)
      WHERE t.owner_user_id=$1::uuid AND t.origin_node_id=$2 ORDER BY t.thread_id`,
      [gateway.userId, node],
    );

    const oldThreads = legacy.map((row) => fromBinary(ui.ThreadSnapshotSchema, row.snapshot).thread!);
    const oldMs = performance.now() - started;
    const fastStart = performance.now();
    const result = await mirror.threads(node, create(ui.ListThreadsRequestSchema, { includeArchived: true }));
    const newMs = performance.now() - fastStart;
    expect(result.map((t) => t.id)).toEqual(oldThreads.map((t) => qualifyId(t.id, node)));

    const bytes = await store.query<{ snapshot: string; metadata: string }>(
      `SELECT sum(octet_length(snapshot))::text AS snapshot,
      sum(octet_length(thread_metadata))::text AS metadata FROM computer_mirror_threads WHERE owner_user_id=$1::uuid AND origin_node_id=$2`,
      [gateway.userId, node],
    );

    console.info("Mirror list measurement", {
      threads: result.length,
      legacyMs: Math.round(oldMs),
      metadataMs: Math.round(newMs),
      ...bytes[0],
    });
    await store.query(
      "UPDATE computer_mirror_threads SET snapshot=$3 WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
      [gateway.userId, node, new Uint8Array([0xff])],
    );
    expect(await mirror.threads(node, create(ui.ListThreadsRequestSchema, { includeArchived: true }))).toEqual(result);
    expect(await mirror.threads(node, create(ui.ListThreadsRequestSchema, { projectId: crypto.randomUUID() }))).toEqual(
      [],
    );
    expect(await mirror.threads(node, create(ui.ListThreadsRequestSchema))).toHaveLength(99);
    const other = new ThreadMirror(new ComputerStore(gateway.runtime, crypto.randomUUID(), gateway.secretsKey));
    expect(await other.threads(node, create(ui.ListThreadsRequestSchema))).toEqual([]);
  }, 15_000);

  test("listing survives a snapshot row above the SQL driver's wire-message limit", async () => {
    await store.query(
      `UPDATE computer_mirror_threads SET snapshot=repeat('x',17*1024*1024)::bytea
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid`,
      [gateway.userId, node, ids[0]!],
    );
    await expect(
      store.query("SELECT snapshot FROM computer_mirror_threads WHERE thread_id=$1::uuid", [ids[0]!]),
    ).rejects.toThrow("Failed to parse server messages");
    expect(await mirror.threads(node, create(ui.ListThreadsRequestSchema, { includeArchived: true }))).toHaveLength(
      100,
    );
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
    expect(await mirror.threads(node, create(ui.ListThreadsRequestSchema))).toHaveLength(100);
    await expect(
      store.query(
        "UPDATE computer_mirror_threads SET thread_metadata=NULL WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
        [gateway.userId, node],
      ),
    ).rejects.toBeDefined();
  });
});
