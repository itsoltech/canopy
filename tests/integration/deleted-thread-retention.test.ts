import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("deleted thread recovery window", () => {
  let gateway: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const query = <T extends object = Record<string, string>>(sql: string, args: readonly unknown[] = []) =>
    gateway.core.linkedAgents.query<T>(sql, [...args]);

  const createThread = async (message?: string) => {
    const thread = (
      await gateway.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        ...(message && { initialMessage: message }),
      })
    ).thread!;

    await eventually(
      () => gateway.api.getThread({ threadId: thread.id }),
      (row) => row.thread?.status === "idle",
    );

    return thread.id;
  };

  const ageDeletion = (thread: string, days: number) =>
    query("UPDATE threads SET deleted_at=now()-make_interval(days=>$2) WHERE id=$1::uuid", [thread, days]);

  const prune = async () => {
    await query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [gateway.userId]);
    await gateway.runtime.runPromise(pruneDatabase(gateway.userId));
  };

  const row = async (thread: string) =>
    (
      await query<{ deleted_at: string | null; purged_at: string | null; purge_completed_at: string | null }>(
        "SELECT deleted_at,purged_at,purge_completed_at FROM threads WHERE id=$1::uuid",
        [thread],
      )
    )[0]!;

  const purge = async (thread: string) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await row(thread)).purge_completed_at) return;
      await prune();
    }

    throw new Error("Deleted thread purge did not finish");
  };

  beforeAll(async () => {
    gateway = await startTestGateway();
    projectId = (await gateway.api.createProject({ name: "Deleted thread retention" })).project!.id;
    workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/deleted-retention" })
    ).workspace!.id;
  }, 60_000);
  afterAll(async () => gateway?.close());

  test("purges after 31 days with archive retention disabled and keeps recent deletions restorable", async () => {
    const expired = await createThread("expired history");
    const recent = await createThread("recent history");
    expect((await gateway.api.getSettings({})).user?.threadRetention?.archivedThreadDays).toBe(0);

    for (const thread of [expired, recent]) await gateway.api.deleteThread({ threadId: thread });
    await ageDeletion(expired, 32);
    await ageDeletion(recent, 30);
    const deletedAt = (await row(expired)).deleted_at;
    await purge(expired);
    expect((await row(expired)).deleted_at).toEqual(deletedAt);
    expect((await row(expired)).purged_at).toBeTruthy();
    expect(await query("SELECT 1 FROM thread_events WHERE thread_id=$1::uuid", [expired])).toHaveLength(0);
    expect(await query("SELECT 1 FROM thread_items WHERE thread_id=$1::uuid", [expired])).toHaveLength(0);
    expect(await failure(gateway.api.restoreThread({ threadId: expired }))).toContain("permanently");
    expect((await row(recent)).purged_at).toBeNull();
    await gateway.api.restoreThread({ threadId: recent });
    expect((await row(recent)).deleted_at).toBeNull();
    expect(await query("SELECT 1 FROM thread_events WHERE thread_id=$1::uuid", [recent])).not.toHaveLength(0);
  });

  test("uses deletion time even when an old archive would already qualify", async () => {
    const current = (await gateway.api.getSettings({})).user!;
    await gateway.api.updateUserSettings({
      expectedVersion: current.version,
      threadRetention: { archivedThreadDays: 1 },
    });
    const thread = await createThread("old archive, recent deletion");
    await gateway.api.setThreadArchived({ threadId: thread, archived: true });
    await query("UPDATE threads SET archived_at=now()-interval '90 days' WHERE id=$1::uuid", [thread]);
    await gateway.api.deleteThread({ threadId: thread });
    await prune();
    expect((await row(thread)).purged_at).toBeNull();
    await gateway.api.restoreThread({ threadId: thread });
    await gateway.api.setThreadArchived({ threadId: thread, archived: false });
    await gateway.api.deleteThread({ threadId: thread });
    await prune();
    expect((await row(thread)).purged_at).toBeNull();
  });

  test("a restorable fork protects its deleted source until both recovery windows expire", async () => {
    const source = await createThread("fork history");

    const turn = (
      await query<{ id: string }>(
        "SELECT id FROM turns WHERE thread_id=$1::uuid AND status='completed' ORDER BY ordinal DESC LIMIT 1",
        [source],
      )
    )[0]!.id;

    const fork = (await gateway.api.createThread({ forkThreadId: source, forkAtTurnId: turn })).thread!.id;

    await eventually(
      () => gateway.api.getThread({ threadId: fork }),
      (value) => value.thread?.status === "idle",
    );
    await gateway.api.deleteThread({ threadId: source });
    await ageDeletion(source, 32);
    await prune();
    expect((await row(source)).purged_at).toBeNull();
    await gateway.api.deleteThread({ threadId: fork });
    await ageDeletion(fork, 30);
    await prune();
    expect((await row(source)).purged_at).toBeNull();
    await ageDeletion(fork, 32);
    await purge(fork);
    await purge(source);
    expect((await row(source)).purge_completed_at).toBeTruthy();
  });

  test("stale background projections do not retain an expired deletion forever", async () => {
    const thread = await createThread();
    await query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES($1::uuid,'closed-process','background_task','in_progress','{}',1,1)`,
      [thread],
    );
    await gateway.api.deleteThread({ threadId: thread });
    await ageDeletion(thread, 32);
    await purge(thread);
    expect((await row(thread)).purge_completed_at).toBeTruthy();
  });

  test("a restore before qualification cancels expiry and deleting again starts a new window", async () => {
    const thread = await createThread("restored content");
    await gateway.api.deleteThread({ threadId: thread });
    await ageDeletion(thread, 32);
    await gateway.api.restoreThread({ threadId: thread });
    await prune();
    expect((await row(thread)).purged_at).toBeNull();
    await gateway.api.deleteThread({ threadId: thread });
    await prune();
    expect((await row(thread)).purged_at).toBeNull();
    expect(await query("SELECT 1 FROM thread_events WHERE thread_id=$1::uuid", [thread])).not.toHaveLength(0);
  });
});
