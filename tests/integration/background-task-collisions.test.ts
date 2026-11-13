import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { BackgroundTaskKind, ItemStatus, Provider, ThreadEventSchema, type StartTurn } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { BackgroundTaskStore, GatewayStore, Ingest } from "@canopy/gateway/store";
import { measureKey } from "@canopy/domain/diagnostics";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("background continuation collisions over gRPC", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  const logs: string[] = [];

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { claude: true }, log: (line) => logs.push(line) });
    projectId = (await gw.api.createProject({ name: "Continuation collisions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  const query = <A extends object>(statement: string, params: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient).unsafe<A>(statement, params);
      }),
    );

  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (all) => all.some((u) => u.change.case === "snapshot"));
    const change = updates[0]!.change;

    if (change.case !== "snapshot") throw new Error("Expected snapshot");

    return change.value;
  };

  const startTasks = async () => {
    const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CLAUDE, title: "Tasks" }))
      .thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );
    gw.worker.holdTurns = true;

    const turn = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Start tasks", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await eventually(
      () => snapshot(thread.id),
      (s) => s.turns[0]?.status === "running",
    );

    for (const taskId of ["one", "two"])
      gw.worker.emit(thread.id, turn.id, {
        case: "itemStarted",
        value: {
          item: {
            itemId: taskId,
            status: ItemStatus.IN_PROGRESS,
            content: {
              case: "backgroundTask",
              value: {
                taskId,
                kind: BackgroundTaskKind.SHELL,
                command: "ci",
                startedInTurnId: turn.id,
              },
            },
          },
        },
      });
    gw.worker.finish(thread.id, turn.id);
    gw.worker.holdTurns = false;
    expect(
      (
        await eventually(
          () => snapshot(thread.id),
          (s) => s.turns[0]?.status === "completed",
        )
      ).turns[0]?.status,
    ).toBe("completed");

    return thread.id;
  };

  const end = (threadId: string, taskId: string) =>
    create(ThreadEventSchema, {
      threadId,
      eventId: crypto.randomUUID(),
      journalSeq: taskId === "one" ? 100n : 101n,
      occurredAt: timestampFromMs(Date.now()),
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: taskId,
            status: ItemStatus.INTERRUPTED,
            content: {
              case: "backgroundTask",
              value: {
                taskId,
                kind: BackgroundTaskKind.SHELL,
                command: "ci",
                stopReason: "stopped",
              },
            },
          },
        },
      },
    });

  const restart = async () => {
    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage, worker: { claude: true }, log: (line) => logs.push(line) });
  };

  test("a second end during dispatched StartTurn waits for admission; restart and replay deliver each note once", async () => {
    const threadId = await startTasks();
    const first = end(threadId, "one");
    const second = end(threadId, "two");
    let continuation: StartTurn | undefined;
    gw.worker.handlers.set("startTurn", (value) => {
      if (!("turnId" in value) || !("thread" in value)) throw new Error("Expected StartTurn");
      continuation = value;
      // Both ends arrive while StartTurn's acknowledgement/turn_started are still in flight.
      gw.worker.link.send({ case: "threadEvent", value: second });
    });
    gw.worker.link.send({ case: "threadEvent", value: first });
    await eventually(
      () =>
        query<{ status: string }>("SELECT status FROM background_task_notes WHERE thread_id=$1 AND item_id='two'", [
          threadId,
        ]),
      (rows) => rows[0]?.status === "waiting",
    );
    await gw.core.backgroundTasks.deliver(threadId);
    const pending = await snapshot(threadId);

    expect(continuation).toBeDefined();
    expect(pending.turns.filter((t) => t.trigger === "background_task")).toHaveLength(1);
    expect(pending.steers).toEqual([]);

    await restart();
    gw.worker.link.send({ case: "threadEvent", value: first });
    gw.worker.link.send({ case: "threadEvent", value: second });

    const finished = await eventually(
      () => snapshot(threadId),
      (s) =>
        s.turns.filter((t) => t.trigger === "background_task").length === 2 &&
        s.turns.every((t) => t.status === "completed"),
    );

    const turns = finished.turns.filter((t) => t.trigger === "background_task");
    expect(turns.map((t) => t.backgroundItemIds)).toEqual([["one"], ["two"]]);
    expect(turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(turns[0]?.id).toBe(continuation!.turnId);
    expect(gw.worker.inputs.get(threadId)).toHaveLength(2);
    await gw.core.backgroundTasks.tick();
    expect((await snapshot(threadId)).turns).toHaveLength(3);
    expect(
      await query<{ item_id: string; status: string }>(
        "SELECT item_id, status FROM background_task_notes WHERE thread_id=$1 ORDER BY item_id",
        [threadId],
      ),
    ).toEqual([
      { item_id: "one", status: "delivered" },
      { item_id: "two", status: "delivered" },
    ]);
  }, 30_000);

  test("a legacy already-running rejection is atomically requeued with the same turn and survives gateway restart", async () => {
    const threadId = await startTasks();
    let turnId = "";
    gw.worker.handlers.set("startTurn", (value, reply) => {
      if (!("turnId" in value)) throw new Error("Expected StartTurn");
      turnId = value.turnId;
      reply(false, { errorCode: "THREAD_ERROR", errorMessage: "a turn of this thread is already running" });
    });
    gw.worker.link.send({ case: "threadEvent", value: end(threadId, "one") });

    const attempts = await eventually(
      () =>
        query<{ status: string; turn_id: string }>(
          "SELECT status, turn_id FROM worker_commands WHERE turn_id=$1 ORDER BY created_at, id",
          [turnId || crypto.randomUUID()],
        ),
      (rows) => rows.length === 2,
    );

    expect(attempts).toEqual([
      { status: "failed", turn_id: turnId },
      { status: "pending", turn_id: turnId },
    ]);
    expect((await snapshot(threadId)).turns.find((t) => t.id === turnId)?.status).toBe("queued");
    expect(logs.some((line) => line.includes(`turn_start_requeued thread=${threadId} turn=${turnId}`))).toBe(true);
    expect(
      gw.core.diagnostics.collector.minutes.between(0, Infinity).some((slot) => slot.measures?.has(measureKey(44))),
    ).toBe(true);
    await restart();

    const done = await eventually(
      () => snapshot(threadId),
      (s) => s.turns.find((t) => t.id === turnId)?.status === "completed",
    );

    expect(done.turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(done.turns.find((t) => t.id === turnId)?.backgroundItemIds).toEqual(["one"]);
    expect(gw.worker.inputs.get(threadId)).toHaveLength(1);

    // A repeated result for the rejected command cannot replace or fail the successful turn.
    const old = (
      await query<{ id: string }>("SELECT id FROM worker_commands WHERE turn_id=$1 AND status='failed'", [turnId])
    )[0]!;

    expect(await gw.runtime.runPromise(GatewayStore.use((s) => s.retryTurnStart(old.id, {})))).toBeUndefined();
    expect((await snapshot(threadId)).turns.find((t) => t.id === turnId)?.status).toBe("completed");
  }, 30_000);

  test("restart between saving a note turn and dispatching it recovers the same turn", async () => {
    const threadId = await startTasks();
    await gw.runtime.runPromise(Ingest.use((s) => s.ingest(gw.workerId, "before-dispatch", [end(threadId, "one")])));
    const delivery = await gw.runtime.runPromise(BackgroundTaskStore.use((s) => s.deliver(threadId, { graceMs: 0 })));
    expect(delivery.turn).toBeDefined();
    expect(await query("SELECT id FROM worker_commands WHERE turn_id=$1", [delivery.turn!.id])).toEqual([]);
    await restart();
    await gw.core.backgroundTasks.tick();

    const done = await eventually(
      () => snapshot(threadId),
      (s) => s.turns.find((t) => t.id === delivery.turn!.id)?.status === "completed",
    );

    expect(done.turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(done.turns[1]?.backgroundItemIds).toEqual(["one"]);
    expect(gw.worker.inputs.get(threadId)).toHaveLength(1);
  }, 30_000);

  test("restart between saving a note steer and dispatching it recovers the same input", async () => {
    const threadId = await startTasks();
    gw.worker.holdTurns = true;

    const held = (await gw.api.sendMessage({ threadId, text: "Keep working", clientRequestId: crypto.randomUUID() }))
      .turn!;

    await eventually(
      () => snapshot(threadId),
      (s) => s.turns.find((t) => t.id === held.id)?.status === "running",
    );
    await gw.runtime.runPromise(
      Ingest.use((s) => s.ingest(gw.workerId, "before-steer-dispatch", [end(threadId, "one")])),
    );
    const delivery = await gw.runtime.runPromise(BackgroundTaskStore.use((s) => s.deliver(threadId, { graceMs: 0 })));
    expect(delivery.steerId).toBeDefined();
    expect(await query("SELECT id FROM worker_commands WHERE id=$1", [delivery.steerId!])).toEqual([]);
    await restart();
    // The harness survived the gateway restart; replay its acceptance of the recovered steer.
    gw.worker.handlers.set("steerTurn", (value, reply) => {
      if (!("inputId" in value)) throw new Error("Expected SteerTurn");
      reply(true);
      gw.worker.emit(threadId, held.id, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: `user-${value.inputId}`,
            status: ItemStatus.COMPLETED,
            content: { case: "userMessage", value: { clientId: value.inputId, text: value.input!.text } },
          },
        },
      });
    });

    try {
      await gw.core.backgroundTasks.tick();

      const done = await eventually(
        () => snapshot(threadId),
        (s) =>
          s.steers.some((steer) => steer.id === delivery.steerId && steer.status === "delivered") &&
          s.items.some(
            (i) => i.item?.content.case === "userMessage" && i.item.content.value.clientId === delivery.steerId,
          ),
      );

      expect(done.steers).toEqual([
        expect.objectContaining({ id: delivery.steerId, status: "delivered", backgroundItemIds: ["one"] }),
      ]);
      expect(done.turns.filter((t) => t.trigger === "background_task")).toHaveLength(0);
      expect(
        done.items.filter(
          (i) => i.item?.content.case === "userMessage" && i.item.content.value.clientId === delivery.steerId,
        ),
      ).toHaveLength(1);
    } finally {
      gw.worker.handlers.delete("steerTurn");
      gw.worker.finish(threadId, held.id);
    }
  }, 30_000);

  test("archive during a collision retry prevents the delayed start", async () => {
    const threadId = await startTasks();
    let starts = 0;
    gw.worker.handlers.set("startTurn", (_value, reply) => {
      starts++;
      reply(false, { errorCode: "THREAD_ERROR", errorMessage: "a turn of this thread is already running" });
    });

    try {
      gw.worker.link.send({ case: "threadEvent", value: end(threadId, "one") });
      await eventually(
        async () => logs.some((line) => line.includes(`turn_start_requeued thread=${threadId}`)),
        Boolean,
      );
      await gw.api.setThreadArchived({ threadId, archived: true });
      const before = starts;
      await Bun.sleep(1_200);
      await gw.core.backgroundTasks.tick();
      expect(starts).toBe(before);
      const done = await snapshot(threadId);
      expect(done.turns.find((t) => t.trigger === "background_task")?.status).toBe("cancelled");
      expect(done.turns.some((t) => t.status === "failed")).toBe(false);
    } finally {
      gw.worker.handlers.delete("startTurn");
    }
  }, 30_000);

  test("an ordinary platform error still fails the turn", async () => {
    const threadId = await startTasks();
    gw.worker.handlers.set("startTurn", (_value, reply) =>
      reply(false, { errorCode: "THREAD_ERROR", errorMessage: "workspace is unavailable" }),
    );

    try {
      gw.worker.link.send({ case: "threadEvent", value: end(threadId, "one") });

      const done = await eventually(
        () => snapshot(threadId),
        (s) => s.turns.some((t) => t.status === "failed"),
      );

      expect(done.turns.find((t) => t.trigger === "background_task")).toMatchObject({
        status: "failed",
        error: "workspace is unavailable",
      });
    } finally {
      gw.worker.handlers.delete("startTurn");
    }
  }, 30_000);
});
