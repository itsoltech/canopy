import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { GoalDirective, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "@canopy/gateway/store";
import { coreDeliver } from "../../apps/gateway/src/core/core-commands.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("worker outbox across a module transition on another gateway", () => {
  let home: TestGateway;
  let settings: TestGateway;

  beforeAll(async () => {
    home = await startTestGateway({
      worker: { hello: { capabilities: ["bot_harness_v1", "bot_web_v1", "bot_workspace_v1"] } },
    });
    const other = await home.addWorker("settings worker");
    settings = await startTestGateway({
      storage: {
        pg: home.pg,
        secretsKey: home.secretsKey,
        workerId: other.workerId,
        workerCredential: other.credential,
      },
    });
  }, 60000);

  afterAll(async () => {
    await settings?.close(true);
    await home?.close();
  });

  async function enable(...enabled: string[]) {
    const { user } = await settings.api.getSettings({});
    await settings.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
  }

  async function createThread(workerId = home.workerId) {
    const projectId = (await home.api.createProject({ name: crypto.randomUUID() })).project!.id;
    const workspaceId = (await home.api.createWorkspace({ projectId, workerId, rootPath: "/repo" })).workspace!.id;
    const threadId = (await home.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
    await eventually(
      () => home.api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );

    return threadId;
  }

  test("replayed offline native starts cannot enter the resumed queue ahead of their journal commit", async () => {
    const threadId = await createThread();
    const providerTurn = crypto.randomUUID();
    const release = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();
    const repeatedUnload = Promise.withResolvers<void>();
    let unloads = 0;
    home.worker.handlers.set("unloadThread", (value, reply) => {
      if ("threadId" in value && value.threadId === threadId) {
        unloads++;

        if (unloads === 1)
          home.worker.emit(threadId, providerTurn, {
            case: "turnStarted",
            value: { providerTurnRef: "native:old-turn" },
          });

        if (unloads === 2) repeatedUnload.resolve();
      }

      reply(true);
    });
    await enable("bots");
    await enable("threads", "bots");

    const delayed = home.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM threads WHERE id=${threadId}::uuid FOR UPDATE`;
            holding.resolve();
            yield* Effect.promise(() => release.promise);
          }),
        ),
      ),
    );

    try {
      await holding.promise;
      home.worker.link.send({ case: "heartbeat", value: {} });
      await repeatedUnload.promise;
      release.resolve();
      await delayed;
      await eventually(
        () =>
          home.core.linkedAgents.query<{ status: string }>(
            "SELECT status FROM worker_commands WHERE thread_id=$1 AND kind='unloadThread'",
            [threadId],
          ),
        (rows) => rows[0]?.status === "completed",
      );
      expect(await home.core.linkedAgents.query("SELECT id FROM turns WHERE id=$1", [providerTurn])).toEqual([]);
    } finally {
      release.resolve();
      await delayed;
      home.worker.handlers.delete("unloadThread");
    }
  }, 15000);

  test("stops the exact bot harness turn and rejects an unacknowledged command after re-enable", async () => {
    const bot = (
      await home.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: "Harness cancellation",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          workerId: home.workerId,
        },
      })
    ).bot!;

    const received = Promise.withResolvers<() => void>();
    home.worker.handlers.set("runBotTurn", (_, reply) => received.resolve(() => reply(true)));
    home.core.bots.start();

    try {
      await home.api.sendBotMessage({
        botId: bot.id,
        text: "Hold the harness ACK",
        clientRequestId: crypto.randomUUID(),
      });
      const lateAck = await received.promise;

      const prefetched = (
        await home.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(home.workerId)))
      ).find((c) => c.command.kind.case === "runBotTurn" && c.command.kind.value.botId === bot.id)!.command;

      await enable("threads");
      await enable("threads", "bots");
      lateAck();
      await coreDeliver(home.core, home.workerId, prefetched);
      home.worker.link.send({ case: "heartbeat", value: {} });
      await eventually(
        async () => home.worker.commands,
        (commands) =>
          commands.some(
            (c) =>
              c.case === "interruptBotTurn" && c.value.threadId === bot.id && c.value.turnId === prefetched.commandId,
          ),
      );

      expect(
        await home.core.linkedAgents.query("SELECT status FROM worker_commands WHERE id=$1", [prefetched.commandId]),
      ).toEqual([{ status: "expired" }]);
      expect(home.worker.commands.filter((c) => c.case === "runBotTurn" && c.value.botId === bot.id)).toHaveLength(1);
    } finally {
      home.worker.handlers.delete("runBotTurn");
      await home.core.bots.stop();
    }
  }, 20000);

  test("workers with a no-op unload must pause native goals and stop reported tasks before resuming", async () => {
    const device = await home.addWorker("earlier worker");
    const worker = await home.connect(device.workerId, device.credential);
    const threadId = await createThread(device.workerId);
    let nativeGoalActive = true;
    let taskRunning = true;
    let reportedLate = false;
    let lateTaskStopped = false;
    const pause = Promise.withResolvers<() => void>();

    const reportTask = (taskId: string) =>
      worker.emit(threadId, "", {
        case: "itemStarted",
        value: {
          item: {
            itemId: taskId,
            status: ItemStatus.IN_PROGRESS,
            content: { case: "backgroundTask", value: { taskId } },
          },
        },
      });

    worker.handlers.set("unloadThread", (_, reply) => {
      if (!reportedLate) {
        reportedLate = true;
        reportTask("late-journal-task");
      }

      reply(true);
    });
    worker.handlers.set("setGoal", (value, reply) => {
      if ("directive" in value && value.directive === GoalDirective.PAUSE) {
        if (!nativeGoalActive) return reply(true);
        pause.resolve(() => {
          nativeGoalActive = false;
          reply(true);
        });

        return;
      }

      nativeGoalActive = true;
      reply(true);
    });
    worker.handlers.set("stopTask", (value, reply) => {
      if ("taskId" in value && value.taskId === "native-task") taskRunning = false;

      if ("taskId" in value && value.taskId === "late-journal-task") lateTaskStopped = true;
      reply(true);
    });

    await home.api.setGoal({ threadId, action: "set", objective: "Native goal" });
    worker.emit(threadId, "", { case: "goalState", value: { nativeStatus: "active", objective: "Native goal" } });
    reportTask("native-task");
    await eventually(
      () => home.api.getThread({ threadId }),
      (r) => r.thread?.backgroundTasks === 1,
    );
    await enable("bots");
    worker.link.send({ case: "heartbeat", value: {} });
    const acknowledgePause = await pause.promise;
    await eventually(
      async () => taskRunning,
      (running) => !running,
    );
    expect(nativeGoalActive).toBe(true);
    expect(worker.commands.some((c) => c.case === "unloadThread")).toBe(false);
    acknowledgePause();

    const unload = () =>
      home.core.linkedAgents.query<{ status: string }>(
        "SELECT status FROM worker_commands WHERE thread_id=$1 AND kind='unloadThread'",
        [threadId],
      );

    await eventually(unload, (rows) => rows[0]?.status === "completed");
    expect(nativeGoalActive).toBe(false);
    expect(taskRunning).toBe(false);
    expect(lateTaskStopped).toBe(true);
    await enable("threads", "bots");
    worker.link.send({ case: "heartbeat", value: {} });
    await eventually(
      async () => nativeGoalActive,
      (active) => active,
    );
  }, 20000);

  test("a retained rewind resumes after unload on the same link that reconnected while disabled", async () => {
    const device = await home.addWorker("rewind worker");

    const connect = () =>
      home.connect(device.workerId, device.credential, undefined, {
        hello: { capabilities: ["thread_rewind_v1"] },
      });

    const worker = await connect();
    const threadId = await createThread(device.workerId);

    const target = (
      await home.api.sendMessage({ threadId, text: "Edit after reconnect", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await eventually(
      () => home.core.linkedAgents.query<{ status: string }>("SELECT status FROM turns WHERE id=$1", [target.id]),
      (rows) => rows[0]?.status === "completed",
    );
    worker.link.close();
    await eventually(
      async () => home.core.link.connections.get(device.workerId)?.isOpen,
      (open) => !open,
    );

    const pending = await home.runtime.runPromise(
      GatewayStore.use((s) =>
        s.beginRewind(
          home.userId,
          create(ui.ThreadRewindRequestSchema, { threadId, turnId: target.id, clientRequestId: crypto.randomUUID() }),
        ),
      ),
    );

    await enable("bots");

    const resumed = await connect();
    await eventually(
      () =>
        home.core.linkedAgents.query<{ status: string }>(
          "SELECT status FROM worker_commands WHERE thread_id=$1 AND kind='unloadThread'",
          [threadId],
        ),
      (rows) => rows[0]?.status === "completed",
    );
    expect(resumed.commands.some((command) => command.case === "rewindThread")).toBe(false);

    await enable("threads", "bots");
    resumed.link.send({ case: "heartbeat", value: {} });
    await eventually(
      () => home.api.getThreadRewind({ threadId, rewindId: pending.operation.id }),
      (r) => r.status === "completed",
    );
    expect(resumed.commands.filter((command) => command.case === "rewindThread")).toHaveLength(1);
  }, 20000);

  test("repackages offline input once and interrupts legacy starts whose dispatch is unknown", async () => {
    const device = await home.addWorker("offline input");
    const worker = await home.connect(device.workerId, device.credential);
    const fresh = await createThread(device.workerId);
    const legacy = await createThread(device.workerId);
    worker.link.close();
    await eventually(
      async () => home.core.link.connections.get(device.workerId)?.isOpen,
      (open) => !open,
    );

    const send = async (threadId: string) =>
      (await home.api.sendMessage({ threadId, text: "Queued offline", clientRequestId: crypto.randomUUID() })).turn!.id;

    const freshTurn = await send(fresh);
    const legacyTurn = await send(legacy);

    const original = await home.core.linkedAgents.query<{ id: string }>(
      "SELECT id FROM worker_commands WHERE turn_id=$1 AND kind='startTurn' AND delivered_epoch=0 AND status='pending'",
      [freshTurn],
    );

    expect(original).toHaveLength(1);
    await home.core.linkedAgents.query("UPDATE worker_commands SET delivered_epoch=NULL WHERE turn_id=$1", [
      legacyTurn,
    ]);
    await enable("bots");

    const status = (id: string) => home.core.linkedAgents.query("SELECT status FROM turns WHERE id=$1", [id]);

    expect(await status(freshTurn)).toEqual([{ status: "queued" }]);
    expect(await status(legacyTurn)).toEqual([{ status: "interrupted" }]);
    await enable("threads", "bots");
    const resumed = await home.connect(device.workerId, device.credential);
    await eventually(
      async () => resumed.commands,
      (commands) => commands.some((c) => c.case === "startTurn" && c.value.turnId === freshTurn),
    );
    expect(resumed.commands.filter((c) => c.case === "startTurn" && c.value.turnId === freshTurn)).toHaveLength(1);
    expect(resumed.commands.some((c) => c.case === "startTurn" && c.value.turnId === legacyTurn)).toBe(false);

    const commands = await home.core.linkedAgents.query<{ id: string; status: string }>(
      "SELECT id,status FROM worker_commands WHERE turn_id=$1 AND kind='startTurn' ORDER BY created_at,id",
      [freshTurn],
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ id: original[0]!.id, status: "expired" });
    expect(commands[1]!.id).not.toBe(original[0]!.id);
  }, 20000);

  test("a lost start ACK stays fenced through rapid re-enable, worker heartbeat and reconnect", async () => {
    const threadId = await createThread();
    const received = Promise.withResolvers<() => void>();
    home.worker.handlers.set("startTurn", (_, reply) => received.resolve(() => reply(true)));

    const turn = (await home.api.sendMessage({ threadId, text: "Hold ACK", clientRequestId: crypto.randomUUID() }))
      .turn!;

    const lateAck = await received.promise;

    const prefetched = (await home.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(home.workerId)))).find(
      (c) => c.command.kind.case === "startTurn" && c.command.kind.value.turnId === turn.id,
    )!.command;

    await enable("bots");
    await enable("threads", "bots");
    lateAck();
    await coreDeliver(home.core, home.workerId, prefetched);
    home.worker.link.send({ case: "heartbeat", value: {} });
    await eventually(
      async () => home.worker.commands,
      (commands) => commands.some((c) => c.case === "interruptTurn" && c.value.turnId === turn.id),
    );
    await eventually(
      async () => home.worker.commands,
      (commands) => commands.some((c) => c.case === "unloadThread" && c.value.threadId === threadId),
    );

    const rows = await home.core.linkedAgents.query<{ status: string; turn_status: string }>(
      "SELECT c.status, t.status AS turn_status FROM worker_commands c JOIN turns t ON t.id=c.turn_id WHERE c.id=$1",
      [prefetched.commandId],
    );

    expect(rows).toEqual([{ status: "expired", turn_status: "interrupted" }]);
    expect(home.worker.commands.filter((c) => c.case === "startTurn" && c.value.turnId === turn.id)).toHaveLength(1);
    home.worker.link.close();
    const reconnected = await home.connect(home.workerId, home.workerCredential);
    await settings.api.sendMessage({ threadId, text: "New work", clientRequestId: crypto.randomUUID() });
    reconnected.link.send({ case: "heartbeat", value: {} });
    await eventually(
      async () => reconnected.commands,
      (commands) => commands.some((c) => c.case === "startTurn"),
    );
    expect(reconnected.commands.filter((c) => c.case === "startTurn" && c.value.turnId === turn.id)).toHaveLength(0);
  }, 20000);
});
