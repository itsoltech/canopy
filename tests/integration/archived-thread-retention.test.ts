import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ItemStatus, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { AttachmentStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { startTestGateway, eventually, failure, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("archived thread retention", () => {
  let gateway: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const query = <T extends object = Record<string, string>>(text: string, args: readonly unknown[] = []) =>
    gateway.core.linkedAgents.query<T>(text, [...args]);

  const due = () =>
    query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [gateway.userId]);

  const prune = async (threadsChanged?: (ids: readonly string[]) => Promise<void>) => {
    await due();

    return gateway.runtime.runPromise(pruneDatabase(gateway.userId, threadsChanged));
  };

  const setRetention = async (days: number) => {
    const current = (await gateway.api.getSettings({})).user!;

    return gateway.api.updateUserSettings({
      expectedVersion: current.version,
      threadRetention: { archivedThreadDays: days },
    });
  };

  const createThread = async (title: string, initialMessage?: string, parentThreadId?: string) => {
    const thread = (
      await gateway.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title,
        ...(initialMessage && { initialMessage }),
        ...(parentThreadId && { parentThreadId }),
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    await eventually(
      () => gateway.api.getThread({ threadId: thread.id }),
      (result) => result.thread?.status === "idle",
    );

    return thread;
  };

  const archiveAndAge = async (threadId: string, days = 2) => {
    await gateway.api.setThreadArchived({ threadId, archived: true });
    await query(
      `UPDATE threads SET archived_at=now()-make_interval(days=>$2),updated_at=now()
       WHERE id=$1::uuid`,
      [threadId, days],
    );
  };

  const retentionRow = async (threadId: string) =>
    (
      await query<{
        archived_at: string | null;
        deleted_at: string | null;
        purged_at: string | null;
        purge_completed_at: string | null;
      }>("SELECT archived_at,deleted_at,purged_at,purge_completed_at FROM threads WHERE id=$1::uuid", [threadId])
    )[0];

  const purgeUntilComplete = async (threadId: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await retentionRow(threadId))?.purge_completed_at) return;
      await prune();
    }

    throw new Error(`thread ${threadId} did not finish content purge`);
  };

  const seedSchedule = async (threadId: string) => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO schedules(id,thread_id,project_id,kind,prompt,run_at,next_run_at,created_by_user_id)
       VALUES($1::uuid,$2::uuid,$3::uuid,'once','retained schedule',now()+interval '1 day',
         now()+interval '1 day',$4::uuid)`,
      [id, threadId, projectId, gateway.userId],
    );

    return id;
  };

  const contentWriter = (id: string, mode: "schedule" | "updatedSchedule" | "journal" = "schedule") => {
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();

    const done = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET LOCAL statement_timeout='2500ms'`;

            if (mode === "journal")
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0))`;
            else yield* sql`SELECT id FROM schedules WHERE id=${id}::uuid FOR UPDATE`;

            if (mode === "updatedSchedule")
              yield* sql`UPDATE schedules SET prompt='writer committed' WHERE id=${id}::uuid`;
            ready.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
            yield* Effect.promise(() => release.promise);

            if (mode === "schedule") yield* sql`UPDATE schedules SET prompt='writer committed' WHERE id=${id}::uuid`;

            if (mode === "journal")
              yield* sql`SELECT thread_replication_enqueue(${id}::uuid,'thread','retention-lock')`;
          }),
        );
      }),
    );

    void done.catch((cause) => ready.reject(cause));

    return { ready: ready.promise, done, release: () => release.resolve() };
  };

  const seedPayload = async (threadId: string, turnId?: string, sharedWith?: string) => {
    const eventId = crypto.randomUUID();
    const sha256 = "a".repeat(64);
    const sharedSha256 = "c".repeat(64);
    const visualId = crypto.randomUUID();
    await query(
      `INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,payload,occurred_at)
       VALUES($1::uuid,900,$2::uuid,'worker','notice','{}'::jsonb,now())
       ON CONFLICT DO NOTHING`,
      [threadId, eventId],
    );
    await query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
       VALUES($1::uuid,'retention-item','agentMessage','completed','{}'::jsonb,900,900)
       ON CONFLICT DO NOTHING`,
      [threadId],
    );
    await query(
      `INSERT INTO blobs(sha256,size_bytes,mime_type,data)
       VALUES($1,3,'text/plain','old') ON CONFLICT DO NOTHING`,
      [sha256],
    );
    await query("INSERT INTO thread_blobs(thread_id,sha256) VALUES($1::uuid,$2) ON CONFLICT DO NOTHING", [
      threadId,
      sha256,
    ]);

    if (sharedWith) {
      await query(
        `INSERT INTO blobs(sha256,size_bytes,mime_type,data)
         VALUES($1,6,'text/plain','shared') ON CONFLICT DO NOTHING`,
        [sharedSha256],
      );
      await query("INSERT INTO thread_blobs(thread_id,sha256) VALUES($1::uuid,$2) ON CONFLICT DO NOTHING", [
        threadId,
        sharedSha256,
      ]);
      await query("INSERT INTO thread_blobs(thread_id,sha256) VALUES($1::uuid,$2) ON CONFLICT DO NOTHING", [
        sharedWith,
        sharedSha256,
      ]);
    }

    if (turnId) {
      await query(
        `INSERT INTO thread_visuals(visual_id,version,thread_id,owner_user_id,turn_id,call_id,item_id,title,
          description,height,schema_version,kit_version,spec,sha256,html_document)
         VALUES($1::uuid,1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'retention-item','Retention visual',
          'Visual payload',320,1,1,'{}','${"b".repeat(64)}',false)
         ON CONFLICT DO NOTHING`,
        [visualId, threadId, gateway.userId, turnId, crypto.randomUUID()],
      );
    }
  };

  beforeAll(async () => {
    gateway = await startTestGateway();
    projectId = (await gateway.api.createProject({ name: "Archived retention" })).project!.id;
    workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/retention" })
    ).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("defaults to off, persists days across a new core, checks version and rejects values above 36500", async () => {
    const before = (await gateway.api.getSettings({})).user!;
    expect(before.threadRetention?.archivedThreadDays).toBe(0);
    const disabled = await createThread("retention disabled");
    await archiveAndAge(disabled.id);
    await prune();
    expect((await retentionRow(disabled.id))?.purged_at).toBeNull();
    await gateway.api.setThreadArchived({ threadId: disabled.id, archived: false });

    const saved = (
      await gateway.api.updateUserSettings({
        expectedVersion: before.version,
        threadRetention: { archivedThreadDays: 7 },
      })
    ).settings!;

    expect(saved.threadRetention?.archivedThreadDays).toBe(7);
    expect(saved.version).toBe(before.version + 1n);

    const restarted = new GatewayCore({
      runtime: gateway.runtime,
      userId: gateway.userId,
      instanceId: "retention-settings-restart",
    });

    try {
      expect((await restarted.settings()).user?.threadRetention?.archivedThreadDays).toBe(7);
    } finally {
      restarted.secrets.stop();
    }

    expect(
      await failure(
        gateway.api.updateUserSettings({
          expectedVersion: before.version,
          threadRetention: { archivedThreadDays: 14 },
        }),
      ),
    ).toContain("changed");
    expect(
      await failure(
        gateway.api.updateUserSettings({
          expectedVersion: saved.version,
          threadRetention: { archivedThreadDays: 36501 },
        }),
      ),
    ).toContain("36500");
  });

  test("uses archived_at, resets the timer on unarchive/rearchive, and leaves disabled or recent threads alone", async () => {
    await setRetention(1);
    const expired = await createThread("expired by archive time");
    const recent = await createThread("recent archive");
    const reset = await createThread("timer reset");
    const active = await createThread("active old activity");
    await query("UPDATE threads SET updated_at=now()-interval '30 days' WHERE id=$1::uuid", [active.id]);
    await archiveAndAge(expired.id);
    await gateway.api.setThreadArchived({ threadId: recent.id, archived: true });
    await query("UPDATE threads SET updated_at=now()-interval '30 days' WHERE id=$1::uuid", [recent.id]);
    await gateway.api.setThreadArchived({ threadId: reset.id, archived: true });
    await query("UPDATE threads SET archived_at=now()-interval '2 days' WHERE id=$1::uuid", [reset.id]);
    await gateway.api.setThreadArchived({ threadId: reset.id, archived: false });
    await gateway.api.setThreadArchived({ threadId: reset.id, archived: true });

    await prune();
    expect((await retentionRow(expired.id))?.purged_at).toBeTruthy();
    expect((await retentionRow(recent.id))?.purged_at).toBeNull();
    expect((await retentionRow(reset.id))?.purged_at).toBeNull();
    expect((await retentionRow(active.id))?.deleted_at).toBeNull();
    await purgeUntilComplete(expired.id);

    await query("UPDATE threads SET archived_at=now()-interval '2 days' WHERE id=$1::uuid", [reset.id]);
    await prune();
    expect((await retentionRow(reset.id))?.purged_at).toBeTruthy();
    await purgeUntilComplete(reset.id);
  });

  test("is owner scoped and does not purge an active recent thread from another owner", async () => {
    await setRetention(1);
    const owner = crypto.randomUUID();
    const project = crypto.randomUUID();
    const archived = crypto.randomUUID();
    const active = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Other','other-retention')",
      [project, owner],
    );
    const other = new GatewayCore({ runtime: gateway.runtime, userId: owner, instanceId: "retention-other-owner" });

    try {
      expect((await other.settings()).user?.threadRetention?.archivedThreadDays).toBe(0);
    } finally {
      other.secrets.stop();
    }

    await query(
      `INSERT INTO user_settings(user_id,version,settings)
       VALUES($1::uuid,1,'{"threadRetention":{"archivedThreadDays":1}}'::jsonb)`,
      [owner],
    );
    await query(
      `INSERT INTO threads(id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,status,title,archived_at)
       VALUES($1::uuid,$1::uuid,$3::uuid,$2::uuid,'main','gateway','openai','archived','foreign old',now()-interval '2 days'),
             ($4::uuid,$4::uuid,$3::uuid,$2::uuid,'main','gateway','openai','idle','foreign active',NULL)`,
      [archived, owner, project, active],
    );

    await prune();
    expect((await retentionRow(archived))?.purged_at).toBeNull();
    expect((await query("SELECT status,deleted_at FROM threads WHERE id=$1::uuid", [active]))[0]).toEqual({
      status: "idle",
      deleted_at: null,
    });
  });

  test("defers a live background task, then purges its tombstone and payloads", async () => {
    await setRetention(1);
    const thread = await createThread("background retention");
    const shared = await createThread("shared blob owner");
    await gateway.api.setThreadArchived({ threadId: thread.id, archived: true });
    await query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
       VALUES($1::uuid,'live-background','background_task','in_progress','{}'::jsonb,1,1)`,
      [thread.id],
    );
    await query("UPDATE threads SET archived_at=now()-interval '2 days' WHERE id=$1::uuid", [thread.id]);
    await prune();
    expect((await retentionRow(thread.id))?.purged_at).toBeNull();

    await query("UPDATE thread_items SET status='completed' WHERE thread_id=$1::uuid", [thread.id]);
    await seedPayload(thread.id, undefined, shared.id);
    const legacySha256 = "d".repeat(64);
    await gateway.runtime.runPromise(
      AttachmentStore.use((store) =>
        store.putUnscopedBlob(legacySha256, new TextEncoder().encode("legacy"), "text/plain"),
      ),
    );
    await query("INSERT INTO thread_blobs(thread_id,sha256) VALUES($1::uuid,$2)", [thread.id, legacySha256]);
    await prune();
    await purgeUntilComplete(thread.id);
    expect((await retentionRow(thread.id))?.purged_at).toBeTruthy();
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_events WHERE thread_id=$1::uuid", [thread.id]))[0]?.n,
    ).toBe(0);
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_items WHERE thread_id=$1::uuid", [thread.id]))[0]?.n,
    ).toBe(0);
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_visuals WHERE thread_id=$1::uuid", [thread.id]))[0]?.n,
    ).toBe(0);
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_blobs WHERE thread_id=$1::uuid", [thread.id]))[0]?.n,
    ).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM blobs WHERE sha256=$1", ["a".repeat(64)]))[0]?.n).toBe(0);
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_blobs WHERE thread_id=$1::uuid", [shared.id]))[0]?.n,
    ).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM blobs WHERE sha256=$1", ["c".repeat(64)]))[0]?.n).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM blobs WHERE sha256=$1", [legacySha256]))[0]?.n).toBe(1);
    await gateway.runtime.runPromise(
      AttachmentStore.use((store) =>
        store.putThreadBlob(
          gateway.workerId,
          thread.id,
          "e".repeat(64),
          new TextEncoder().encode("late"),
          "text/plain",
        ),
      ),
    );
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_blobs WHERE thread_id=$1::uuid", [thread.id]))[0]?.n,
    ).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM blobs WHERE sha256=$1", ["e".repeat(64)]))[0]?.n).toBe(0);
  });

  test("protects a fork source while its manually deleted dependent remains restorable", async () => {
    await setRetention(1);
    const source = await createThread("fork source", "source history");
    await eventually(
      () => gateway.api.getThread({ threadId: source.id }),
      (result) => result.thread?.status === "idle",
    );

    const sourceTurns = await eventually(
      () =>
        query<{ id: string }>(
          "SELECT id FROM turns WHERE thread_id=$1::uuid AND status='completed' ORDER BY ordinal DESC LIMIT 1",
          [source.id],
        ),
      (rows) => rows.length === 1,
    );

    const sourceTurn = sourceTurns[0]!.id;
    await seedPayload(source.id, sourceTurn);
    const dependent = (await gateway.api.createThread({ forkThreadId: source.id, forkAtTurnId: sourceTurn })).thread!;
    await eventually(
      () => gateway.api.getThread({ threadId: dependent.id }),
      (result) => result.thread?.status === "idle",
    );
    await gateway.api.deleteThread({ threadId: dependent.id });
    await archiveAndAge(source.id);
    await prune();
    expect((await retentionRow(source.id))?.purged_at).toBeNull();
    expect((await retentionRow(dependent.id))?.purged_at).toBeNull();
    expect((await retentionRow(dependent.id))?.deleted_at).toBeTruthy();
    expect(
      (await query<{ input: { text: string } }>("SELECT input FROM turns WHERE id=$1::uuid", [sourceTurn]))[0]?.input
        .text,
    ).toContain("source history");
    const restored = await gateway.api.restoreThread({ threadId: dependent.id });
    expect(restored.threads.map((thread) => thread.id)).toContain(dependent.id);
    expect((await retentionRow(dependent.id))?.deleted_at).toBeNull();
    await gateway.api.setThreadArchived({ threadId: dependent.id, archived: true });
    await query("UPDATE threads SET archived_at=now()-interval '2 days' WHERE id=ANY($1::uuid[])", [
      `{${source.id},${dependent.id}}`,
    ]);

    await prune();
    expect((await retentionRow(dependent.id))?.purged_at).toBeTruthy();
    expect((await retentionRow(source.id))?.purged_at).toBeNull();
    await prune();
    expect((await retentionRow(source.id))?.purged_at).toBeTruthy();
    await purgeUntilComplete(dependent.id);
    await purgeUntilComplete(source.id);
    expect(await query("SELECT 1 FROM thread_visuals WHERE thread_id=$1::uuid", [source.id])).toHaveLength(0);
    expect(
      (await query<{ input: object }>("SELECT input FROM turns WHERE id=$1::uuid", [sourceTurn]))[0]?.input,
    ).toEqual({});

    const commands = await query<{ status: string; size: number }>(
      "SELECT status,octet_length(payload)::int AS size FROM worker_commands WHERE thread_id=$1::uuid",
      [source.id],
    );

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.status === "completed" && command.size === 0)).toBe(true);
  });

  test("purges the leaf before its parent and publishes only committed deletion ids", async () => {
    await setRetention(1);
    const parent = await createThread("retention parent");
    const leaf = await createThread("retention leaf", undefined, parent.id);
    await archiveAndAge(parent.id);
    await query("UPDATE threads SET archived_at=now()-interval '2 days' WHERE id=$1::uuid", [leaf.id]);
    const published: string[] = [];

    const notify = async (ids: readonly string[]) => {
      for (const id of ids) {
        // This uses a separate SQL execution; an uncommitted fence would still read as null.
        const committed = await retentionRow(id);
        expect(committed?.purged_at).toBeTruthy();
        expect(committed?.deleted_at).toBeTruthy();
        published.push(id);
      }
    };

    await prune(notify);
    expect(published).toEqual([leaf.id]);
    expect((await retentionRow(parent.id))?.purged_at).toBeNull();
    expect((await retentionRow(leaf.id))?.purged_at).toBeTruthy();
    await prune(notify);
    expect(published).toEqual([leaf.id, parent.id]);
    expect((await retentionRow(parent.id))?.purged_at).toBeTruthy();
    await prune(notify);
    expect(published).toEqual([leaf.id, parent.id]);
    await purgeUntilComplete(leaf.id);
    await purgeUntilComplete(parent.id);
  });

  test("purges payloads in 256-record batches across restart and rolls back atomically", async () => {
    await setRetention(1);
    const batch = await createThread("batch purge");
    await archiveAndAge(batch.id);
    await query(
      `INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,payload,occurred_at)
       SELECT $1::uuid,1000+n,gen_random_uuid(),'worker','notice','{}'::jsonb,now()
       FROM generate_series(1,300) n`,
      [batch.id],
    );
    await query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
       SELECT $1::uuid,'batch-'||n,'agentMessage','completed','{}'::jsonb,n,n
       FROM generate_series(1,300) n`,
      [batch.id],
    );

    const before = (
      await query<{ n: number }>("SELECT count(*)::int AS n FROM thread_events WHERE thread_id=$1::uuid", [batch.id])
    )[0]!.n;

    await prune();
    expect((await retentionRow(batch.id))?.purged_at).toBeTruthy();
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_events WHERE thread_id=$1::uuid", [batch.id]))[0]?.n,
    ).toBe(before - 256);

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage });
    await prune();
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_events WHERE thread_id=$1::uuid", [batch.id]))[0]?.n,
    ).toBe(0);
    await prune();
    expect(
      (await query("SELECT count(*)::int AS n FROM thread_items WHERE thread_id=$1::uuid", [batch.id]))[0]?.n,
    ).toBe(44);
    await purgeUntilComplete(batch.id);
    expect((await retentionRow(batch.id))?.purge_completed_at).toBeTruthy();

    const rollback = await createThread("rollback purge");
    await archiveAndAge(rollback.id);

    const eventsBeforeRollback = await query("SELECT seq FROM thread_events WHERE thread_id=$1::uuid ORDER BY seq", [
      rollback.id,
    ]);

    await due();
    await expect(
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* pruneDatabase(gateway.userId);

              const rows = yield* sql<{ purged: boolean }>`SELECT purged_at IS NOT NULL AS purged
                FROM threads WHERE id=${rollback.id}::uuid`;

              expect(rows[0]?.purged).toBe(true);

              return yield* Effect.fail(new Error("crash before commit"));
            }),
          );
        }),
      ),
    ).rejects.toThrow("crash before commit");
    expect((await retentionRow(rollback.id))?.purged_at).toBeNull();
    expect((await retentionRow(rollback.id))?.deleted_at).toBeNull();
    expect(await query("SELECT seq FROM thread_events WHERE thread_id=$1::uuid ORDER BY seq", [rollback.id])).toEqual(
      eventsBeforeRollback,
    );
    expect(
      (
        await query<{ due: boolean }>(
          "SELECT next_run_at<=now() AS due FROM database_maintenance WHERE owner_user_id=$1::uuid",
          [gateway.userId],
        )
      )[0]?.due,
    ).toBe(true);
    await purgeUntilComplete(rollback.id);
  }, 60_000);

  test("keeps the purged tombstone and ACKs a late worker event without recreating history or allowing restore", async () => {
    await setRetention(1);
    const thread = await createThread("late event");
    await gateway.api.setThreadArchived({ threadId: thread.id, archived: true });
    await query("UPDATE threads SET archived_at=now()-interval '2 days' WHERE id=$1::uuid", [thread.id]);
    await prune();
    const row = await retentionRow(thread.id);
    expect(row?.purged_at).toBeTruthy();
    expect(row?.deleted_at).toBeTruthy();

    const before = (
      await query<{ acked_seq: string }>(
        "SELECT acked_seq::text FROM worker_journal_cursors WHERE thread_id=$1::uuid",
        [thread.id],
      )
    )[0]!.acked_seq;

    const lateTurn = crypto.randomUUID();
    gateway.worker.emit(thread.id, lateTurn, {
      case: "itemStarted",
      value: {
        item: {
          itemId: "late-item",
          status: ItemStatus.IN_PROGRESS,
          content: { case: "agentMessage", value: { text: "late" } },
        },
      },
    });

    const acknowledged = await eventually(
      () =>
        query<{ acked_seq: string }>("SELECT acked_seq::text FROM worker_journal_cursors WHERE thread_id=$1::uuid", [
          thread.id,
        ]),
      (rows) => rows.length > 0 && BigInt(rows[0]!.acked_seq) > BigInt(before),
    );

    expect(BigInt(acknowledged[0]!.acked_seq)).toBeGreaterThan(BigInt(before));
    expect(await query("SELECT 1 FROM thread_events WHERE thread_id=$1::uuid", [thread.id])).toHaveLength(0);
    expect(await query("SELECT 1 FROM thread_items WHERE thread_id=$1::uuid", [thread.id])).toHaveLength(0);
    expect(await failure(gateway.api.restoreThread({ threadId: thread.id }))).toMatch(/purged|permanent/i);
    expect((await retentionRow(thread.id))?.purged_at).toBeTruthy();
    await purgeUntilComplete(thread.id);
  });

  test("schedule writers can commit while archive and delete hold the thread and wait for their row", async () => {
    for (const operation of ["archive", "delete"] as const) {
      const thread = await createThread(`concurrent ${operation}`);
      const schedule = await seedSchedule(thread.id);
      const writer = contentWriter(schedule);
      let closing: Promise<string> | undefined;

      try {
        const pid = await writer.ready;
        closing = failure(
          operation === "archive"
            ? gateway.api.setThreadArchived({ threadId: thread.id, archived: true }, { timeoutMs: 5000 })
            : gateway.api.deleteThread({ threadId: thread.id }, { timeoutMs: 5000 }),
        );

        // Lifecycle already owns threads and is waiting on the writer's schedule tuple.
        const blocked = await eventually(
          () =>
            query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
             AND $1::int=ANY(pg_blocking_pids(pid)) AND state='active'
             AND strpos(query,'UPDATE schedules SET status')>0`,
              [pid],
            ),
          (rows) => rows.length === 1,
        );

        expect(blocked).toHaveLength(1);
      } finally {
        writer.release();
        await Promise.allSettled([writer.done, closing]);
      }

      await writer.done;
      expect(await closing).toBe("");
      expect(
        (
          await query<{ status: string; prompt: string }>("SELECT status,prompt FROM schedules WHERE id=$1::uuid", [
            schedule,
          ])
        )[0],
      ).toEqual({ status: "cancelled", prompt: "writer committed" });
    }
  }, 15_000);

  test("maintenance defers an in-flight content writer and retries the fence without duplicate notifications", async () => {
    await setRetention(1);
    const thread = await createThread("maintenance writer");
    const schedule = await seedSchedule(thread.id);
    await archiveAndAge(thread.id);
    const writer = contentWriter(schedule, "updatedSchedule");
    const published: string[] = [];

    const notify = async (ids: readonly string[]) => {
      published.push(...ids);
    };

    try {
      await writer.ready;
      await prune(notify);
      await prune(notify);
      expect((await retentionRow(thread.id))?.purged_at).toBeNull();
      expect(published).toEqual([]);
    } finally {
      writer.release();
      await writer.done;
    }

    expect(
      (await query<{ prompt: string }>("SELECT prompt FROM schedules WHERE id=$1::uuid", [schedule]))[0]?.prompt,
    ).toBe("writer committed");
    await prune(notify);
    expect(published).toEqual([thread.id]);
    await prune(notify);
    expect(published).toEqual([thread.id]);
    await purgeUntilComplete(thread.id);
    expect(
      (await query<{ prompt: string }>("SELECT prompt FROM schedules WHERE id=$1::uuid", [schedule]))[0]?.prompt,
    ).toBe("");
  }, 15_000);

  test("a content row locked before its guard defers completion and cannot restore purged payloads", async () => {
    await setRetention(1);
    const thread = await createThread("purge locked schedule");
    const schedule = await seedSchedule(thread.id);
    await archiveAndAge(thread.id);
    await prune();
    expect((await retentionRow(thread.id))?.purged_at).toBeTruthy();
    const writer = contentWriter(schedule);
    let deferred = false;

    try {
      await writer.ready;

      for (let attempt = 0; attempt < 40; attempt++) {
        if ((await prune()) === 0) {
          deferred = true;
          break;
        }
      }

      expect(deferred).toBe(true);
      expect((await retentionRow(thread.id))?.purge_completed_at).toBeNull();
      expect(await prune()).toBe(0);
    } finally {
      writer.release();
      await writer.done;
    }

    expect(
      (await query<{ prompt: string }>("SELECT prompt FROM schedules WHERE id=$1::uuid", [schedule]))[0]?.prompt,
    ).toBe("retained schedule");
    await purgeUntilComplete(thread.id);
    expect(
      (await query<{ prompt: string }>("SELECT prompt FROM schedules WHERE id=$1::uuid", [schedule]))[0]?.prompt,
    ).toBe("");
  }, 15_000);

  test("maintenance yields the global journal lock before fencing while ordinary replication can commit", async () => {
    await setRetention(1);
    const thread = await createThread("journal lock contention");
    await archiveAndAge(thread.id);
    await query("INSERT INTO thread_replication_sources(thread_id) VALUES($1::uuid) ON CONFLICT DO NOTHING", [
      thread.id,
    ]);
    await query(
      `INSERT INTO thread_replication_clock(thread_id,owner_user_id)
       VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`,
      [thread.id, gateway.userId],
    );
    const writer = contentWriter(thread.id, "journal");

    try {
      await writer.ready;
      expect(await prune()).toBe(0);
      expect((await retentionRow(thread.id))?.purged_at).toBeNull();
      expect((await retentionRow(thread.id))?.deleted_at).toBeNull();
    } finally {
      writer.release();
      await writer.done;
    }

    expect(
      await query("SELECT 1 FROM thread_replication_journal WHERE thread_id=$1::uuid AND entity_id='retention-lock'", [
        thread.id,
      ]),
    ).toHaveLength(1);
    await purgeUntilComplete(thread.id);
  }, 15_000);

  test("finishes an existing purge after auto-delete is disabled and retains the remaining archive", async () => {
    await setRetention(1);
    const started = await createThread("purge already started");
    await archiveAndAge(started.id);
    await query(
      `INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,payload,occurred_at)
       SELECT $1::uuid,1000+n,gen_random_uuid(),'worker','notice','{}'::jsonb,now()
       FROM generate_series(1,300) n`,
      [started.id],
    );
    await prune();
    const fenced = await retentionRow(started.id);
    expect(fenced?.purged_at).toBeTruthy();
    expect(fenced?.purge_completed_at).toBeNull();
    await setRetention(0);
    const retained = await createThread("disabled archive");
    await archiveAndAge(retained.id);
    await purgeUntilComplete(started.id);
    expect((await retentionRow(started.id))?.purge_completed_at).toBeTruthy();
    expect(await query("SELECT 1 FROM thread_events WHERE thread_id=$1::uuid", [started.id])).toHaveLength(0);
    expect((await retentionRow(retained.id))?.purged_at).toBeNull();
    expect((await retentionRow(retained.id))?.deleted_at).toBeNull();
    expect((await gateway.api.getSettings({})).user?.threadRetention?.archivedThreadDays).toBe(0);
  });
});
