import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ItemStatus, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore } from "@canopy/gateway/store";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("archived storage lifecycle", () => {
  let gateway: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const query = <T extends object = Record<string, string>>(sql: string, args: readonly unknown[] = []) =>
    gateway.core.linkedAgents.query<T>(sql, [...args]);

  const createThread = async () => {
    const id = (await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
    await eventually(
      () => gateway.api.getThread({ threadId: id }),
      (value) => value.thread?.status === "idle",
    );

    return id;
  };

  const age = (thread: string) =>
    query("UPDATE threads SET archived_at=now()-interval '32 days' WHERE id=$1::uuid", [thread]);

  const prune = async () => {
    await query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [gateway.userId]);
    await gateway.runtime.runPromise(pruneDatabase(gateway.userId));
  };

  const purge = async (thread: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await prune();
      const rows = await query("SELECT 1 FROM threads WHERE id=$1::uuid AND purge_completed_at IS NOT NULL", [thread]);

      if (rows.length) return;
    }

    throw new Error("Storage purge did not finish");
  };

  const count = async (thread: string) =>
    (
      await query<{ events: number; items: number; journal: number; content: number; blobs: number }>(
        `SELECT
        (SELECT count(*)::int FROM thread_events WHERE thread_id=$1::uuid) AS events,
        (SELECT count(*)::int FROM thread_items WHERE thread_id=$1::uuid) AS items,
        (SELECT count(*)::int FROM thread_replication_journal WHERE thread_id=$1::uuid) AS journal,
        (SELECT count(*)::int FROM thread_replication_content WHERE thread_id=$1::uuid) AS content,
        (SELECT count(*)::int FROM thread_blobs WHERE thread_id=$1::uuid) AS blobs`,
        [thread],
      )
    )[0]!;

  beforeAll(async () => {
    gateway = await startTestGateway();
    projectId = (await gateway.api.createProject({ name: "Storage lifecycle" })).project!.id;
    workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/storage" })
    ).workspace!.id;
    const settings = (await gateway.api.getSettings({})).user!;
    await gateway.api.updateUserSettings({
      expectedVersion: settings.version,
      threadRetention: { archivedThreadDays: 31 },
    });
  }, 60_000);
  afterAll(async () => gateway?.close());

  test("purges legacy base64 and synchronization copies, preserving shared bytes until the last archive expires", async () => {
    const thread = await createThread();
    const shared = await createThread();
    const data = new TextEncoder().encode("shared attachment bytes");
    const sha256 = createHash("sha256").update(data).digest("hex");

    for (const id of [thread, shared])
      await gateway.runtime.runPromise(
        AttachmentStore.use((store) => store.putThreadBlob(gateway.workerId, id, sha256, data, "text/plain")),
      );

    gateway.worker.holdTurns = true;

    const turn = (
      await gateway.api.sendMessage({ threadId: thread, text: "Legacy output", clientRequestId: crypto.randomUUID() })
    ).turn!.id;

    await eventually(
      () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turn]),
      (rows) => rows[0]?.status === "running",
    );

    const raw = JSON.stringify({
      method: "rawResponseItem/completed",
      params: {
        item: {
          call_id: "large-output",
          output: [
            { type: "input_image", image_url: `data:image/png;base64,${Buffer.alloc(4096, 7).toString("base64")}` },
          ],
        },
      },
    });

    gateway.worker.emit(
      thread,
      turn,
      {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "large-output",
            status: ItemStatus.COMPLETED,
            content: { case: "toolCall", value: { name: "large", output: "retained output ".repeat(4096) } },
          },
        },
      },
      raw,
    );

    gateway.worker.finish(thread, turn);
    await eventually(
      () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turn]),
      (rows) => rows[0]?.status === "completed",
    );

    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(
        { threadId: thread, sequence: true },
        { signal: abort.signal, timeoutMs: 5000 },
      ))
        if (update.change.case === "snapshot") break;
    } finally {
      abort.abort();
    }

    const stored = await query<{ raw: object }>(
      "SELECT raw FROM thread_events WHERE thread_id=$1::uuid AND item_id='large-output' AND kind='item_completed'",
      [thread],
    );

    expect(stored[0]?.raw).toEqual(JSON.parse(raw));
    const before = await count(thread);
    expect(before.events).toBeGreaterThan(0);
    expect(before.items).toBeGreaterThan(0);
    expect(before.journal).toBeGreaterThan(0);
    expect(before.content).toBeGreaterThan(0);
    expect(before.blobs).toBe(1);

    await gateway.api.setThreadArchived({ threadId: thread, archived: true });
    await age(thread);
    await gateway.api.deleteThread({ threadId: thread });
    const restorable = await count(thread);
    await prune();
    expect(await count(thread)).toEqual(restorable);
    expect(restorable.events).toBe(before.events);
    expect(restorable.content).toBe(before.content);
    await gateway.api.restoreThread({ threadId: thread });
    await gateway.api.setThreadArchived({ threadId: thread, archived: true });
    await age(thread);
    await purge(thread);
    expect(await count(thread)).toEqual({ events: 0, items: 0, journal: 0, content: 0, blobs: 0 });
    expect((await gateway.api.getThreadBlob({ threadId: shared, sha256 })).data).toEqual(data);

    await gateway.api.setThreadArchived({ threadId: shared, archived: true });
    await age(shared);
    await purge(shared);
    expect(await query("SELECT 1 FROM blobs WHERE sha256=$1", [sha256])).toHaveLength(0);
    expect(
      await query("SELECT 1 FROM threads WHERE id=ANY($1::uuid[]) AND purged_at IS NOT NULL", [
        `{${thread},${shared}}`,
      ]),
    ).toHaveLength(2);
  }, 20_000);
});
