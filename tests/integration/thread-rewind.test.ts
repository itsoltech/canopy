import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, isMessage } from "@bufbuild/protobuf";
import {
  CommandResultSchema,
  MentionKind,
  Provider,
  RewindThreadSchema,
  ui,
  type RewindThread,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, AgentBusStore } from "@canopy/gateway/store";
import { coreDeliver } from "../../apps/gateway/src/core/core-commands.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("in-place durable thread rewind", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  const commands: RewindThread[] = [];

  const installRewind = () =>
    gw.worker.handlers.set("rewindThread", (value, reply) => {
      if (!isMessage(value, RewindThreadSchema)) throw new Error("expected rewind command");
      commands.push(value);
      reply(true, {
        rewind: {
          providerThreadId: value.restoreProviderThreadId || Bun.randomUUIDv7(),
          filesAvailable: value.thread?.provider === Provider.CLAUDE,
          files: ["src/app.ts"],
        },
      });
    });

  const history = (thread: string) =>
    gw.runtime.runPromise(
      GatewayStore.use((store) =>
        Effect.gen(function* () {
          const snapshot = yield* store.snapshot(thread);

          return { ...snapshot, thread: yield* store.thread(thread) };
        }),
      ),
    );

  const waitTurn = (thread: string, count: number) =>
    eventually(
      () => history(thread),
      (snapshot) => snapshot.turns.filter((turn) => turn.status === "completed").length >= count,
    );

  const createThread = async (provider = Provider.CODEX) => {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider,
        title: "Rewind",
        clientRequestId: Bun.randomUUIDv7(),
        initialMessage: "APPLE",
      })
    ).thread!;

    await waitTurn(thread.id, 1);

    for (const text of ["BANANA", "CHERRY"]) {
      await gw.api.sendMessage({ threadId: thread.id, text, clientRequestId: Bun.randomUUIDv7() });
      await waitTurn(thread.id, text === "BANANA" ? 2 : 3);
    }

    return thread;
  };

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { claude: true, hello: { capabilities: ["thread_rewind_v1"] } } });
    installRewind();
    projectId = (await gw.api.createProject({ name: "Rewind" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/rewind" }))
      .workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("goal and schedule boundaries refuse rewind, and pending rewinds fence concurrent mutations", async () => {
    const goalThread = await createThread();
    await gw.api.setGoal({ threadId: goalThread.id, action: "set", objective: "Keep working" });
    expect(
      await failure(
        gw.api.prepareThreadRewind({ threadId: goalThread.id, turnId: (await history(goalThread.id)).turns[0]!.id }),
      ),
    ).toContain("goal or scheduled");
    await gw.api.setGoal({ threadId: goalThread.id, action: "clear" });

    const scheduled = await createThread();

    const schedule = (
      await gw.api.createSchedule({
        threadId: scheduled.id,
        prompt: "later",
        when: { case: "cron", value: "0 9 * * *" },
        timezone: "UTC",
      })
    ).schedule!;

    expect(
      await failure(
        gw.api.prepareThreadRewind({ threadId: scheduled.id, turnId: (await history(scheduled.id)).turns[0]!.id }),
      ),
    ).toContain("goal or scheduled");
    await gw.api.setScheduleStatus({ scheduleId: schedule.id, status: "cancelled" });

    const thread = await createThread();
    const target = (await history(thread.id)).turns[1]!;

    const pending = await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.beginRewind(
          gw.userId,
          create(ui.ThreadRewindRequestSchema, { threadId: thread.id, turnId: target.id, clientRequestId: "fence" }),
        ),
      ),
    );

    expect(await failure(gw.api.setGoal({ threadId: thread.id, action: "set", objective: "racing" }))).toContain(
      "rewinding",
    );

    const archive = await gw.runtime.runPromise(
      GatewayStore.use((store) => store.setThreadArchived(gw.userId, thread.id, true)).pipe(Effect.exit),
    );

    expect(archive._tag).toBe("Failure");
    const cursor = (await history(thread.id)).lastSeq;
    gw.worker.emit(thread.id, Bun.randomUUIDv7(), { case: "turnStarted", value: { providerTurnRef: "unadmitted" } });
    await eventually(
      () => history(thread.id),
      (state) => state.lastSeq > cursor,
    );

    if (pending.command) await coreDeliver(gw.core, gw.workerId, pending.command);
    expect(
      (await gw.api.getThreadRewind({ threadId: thread.id, rewindId: pending.operation.id })).draft?.messageText,
    ).toBe("BANANA");

    // A late source call cannot commit a mutation after its turn was superseded.
    const late = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`INSERT INTO agent_bus_calls(id,source_thread_id,source_turn_id,tool,arguments,status)
        VALUES(${Bun.randomUUIDv7()}::uuid,${thread.id}::uuid,${target.id}::uuid,'send_message','{}'::jsonb,'completed')`;
      }).pipe(Effect.exit),
    );

    expect(late._tag).toBe("Failure");
  });

  test("a failed native rewind keeps history visible and permits a fresh attempt", async () => {
    const thread = await createThread();
    const before = await history(thread.id);
    gw.worker.handlers.set("rewindThread", (_value, reply) => reply(false, { errorMessage: "checkpoint unavailable" }));

    try {
      const result = await gw.api.rewindThread({
        threadId: thread.id,
        turnId: before.turns[1]!.id,
        clientRequestId: "failed",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("checkpoint");
      const after = await history(thread.id);
      expect(after.thread.provider_thread_id).toBe(before.thread.provider_thread_id);
      expect(after.thread.rewind_pending_id).toBeNull();
      expect(after.turns.every((turn) => !turn.rewind_id)).toBe(true);
    } finally {
      installRewind();
    }
  });

  for (const provider of [Provider.CODEX, Provider.CLAUDE])
    test(`${Provider[provider]} preserves history, replaces the native prefix, and supports undo`, async () => {
      const thread = await createThread(provider);
      const before = await history(thread.id);
      const target = before.turns[1]!;
      const preview = await gw.api.prepareThreadRewind({ threadId: thread.id, turnId: target.id });
      expect(preview.messages).toBe(2);
      expect(preview.filesAvailable).toBe(provider === Provider.CLAUDE);
      const request = { threadId: thread.id, turnId: target.id, clientRequestId: Bun.randomUUIDv7() };
      const result = await gw.api.rewindThread(request);
      expect(result.status).toBe("completed");
      expect(result.draft?.messageText).toBe("BANANA");
      const command = commands.at(-1)!;
      expect(command.sourceProviderThreadId).toBe(before.thread.provider_thread_id!);
      expect(command.afterProviderTurnRef).toBe(before.turns[0]!.provider_turn_ref!);
      expect(command.restoreFiles).toBe(false);
      expect(command.cancelledTurnIds).toEqual(before.turns.slice(1).map((turn) => turn.id));
      const rewound = await history(thread.id);
      expect(rewound.thread.id).toBe(thread.id);
      expect(rewound.thread.provider_thread_id).not.toBe(before.thread.provider_thread_id);
      expect(rewound.turns.map((turn) => Boolean(turn.rewind_id))).toEqual([false, true, true]);
      expect(rewound.items.length).toBe(before.items.length);
      expect(rewound.lastSeq).toBeGreaterThan(before.lastSeq);
      expect((await gw.api.rewindThread(request)).rewindId).toBe(result.rewindId);

      const modelHistory = await gw.runtime.runPromise(
        AgentBusStore.use((store) =>
          store.readThread({
            threadId: thread.id,
            afterSeq: 0,
            limit: 100,
            view: "messages",
          }),
        ),
      );

      expect(JSON.stringify(modelHistory.result)).not.toContain("BANANA");
      expect(JSON.stringify(modelHistory.result)).not.toContain("CHERRY");
      const restored = await gw.api.restoreThreadRewind({ threadId: thread.id, rewindId: result.rewindId });
      expect(restored.status).toBe("restored");
      const after = await history(thread.id);
      expect(after.thread.provider_thread_id).toBe(before.thread.provider_thread_id);
      expect(after.turns.every((turn) => !turn.rewind_id)).toBe(true);
    });

  test("new turns use only the replacement session; repeated rewinds use original boundary sessions", async () => {
    const thread = await createThread();
    const before = await history(thread.id);

    const result = await gw.api.rewindThread({
      threadId: thread.id,
      turnId: before.turns[1]!.id,
      clientRequestId: "edit",
    });

    const replacement = (await history(thread.id)).thread.provider_thread_id;
    await gw.api.sendMessage({ threadId: thread.id, text: "BLUEBERRY", clientRequestId: "edited" });
    await waitTurn(thread.id, 4);
    const start = gw.worker.commands.findLast((command) => command.case === "startTurn");
    expect(start?.case === "startTurn" && start.value.thread?.providerThreadId).toBe(replacement!);
    expect(await failure(gw.api.restoreThreadRewind({ threadId: thread.id, rewindId: result.rewindId }))).toContain(
      "before another turn",
    );
    const latest = (await history(thread.id)).turns.at(-1)!;
    await gw.api.rewindThread({ threadId: thread.id, turnId: latest.id, clientRequestId: "repeat" });
    expect(commands.at(-1)!.sourceProviderThreadId).toBe(before.thread.provider_thread_id!);
    expect(commands.at(-1)!.afterProviderTurnRef).toBe(before.turns[0]!.provider_turn_ref!);
  });

  test("intent survives a gateway restart and a duplicate result commits once", async () => {
    const thread = await createThread();
    const before = await history(thread.id);

    const started = await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.beginRewind(
          gw.userId,
          create(ui.ThreadRewindRequestSchema, {
            threadId: thread.id,
            turnId: before.turns[1]!.id,
            clientRequestId: "crash",
          }),
        ),
      ),
    );

    expect(await failure(gw.api.sendMessage({ threadId: thread.id, text: "late", clientRequestId: "late" }))).toContain(
      "rewinding",
    );

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage, worker: { claude: true, hello: { capabilities: ["thread_rewind_v1"] } } });
    installRewind();

    // Reconnect can have delivered the saved intent before the fixture handler was installed; explicitly redeliver it.
    if (started.command) await coreDeliver(gw.core, gw.workerId, started.command);
    await eventually(
      () => history(thread.id),
      (snapshot) => !snapshot.thread.rewind_pending_id,
    );
    const after = await history(thread.id);
    expect(after.turns.slice(1).every((turn) => turn.rewind_id === started.operation.id)).toBe(true);

    const replay = await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.completeRewind(
          started.operation.command_id,
          create(CommandResultSchema, { ok: true, rewind: { providerThreadId: after.thread.provider_thread_id! } }),
        ),
      ),
    );

    expect(replay).toBeUndefined();
    expect((await history(thread.id)).lastSeq).toBe(after.lastSeq);
  });

  test("unknown owners, inherited turns and old workers are refused before writing an intent", async () => {
    const thread = await createThread();
    const turns = (await history(thread.id)).turns;

    const ownerResult = await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.beginRewind(
          Bun.randomUUIDv7(),
          create(ui.ThreadRewindRequestSchema, {
            threadId: thread.id,
            turnId: turns[0]!.id,
            clientRequestId: "foreign",
          }),
        ),
      ).pipe(
        // Inspect the boundary error without losing the test runtime.
        Effect.flip,
      ),
    );

    expect(ownerResult.message).toContain("not found");
    const old = await gw.addWorker("old");
    await gw.connect(old.workerId, old.credential);

    const workspace = (await gw.api.createWorkspace({ projectId, workerId: old.workerId, rootPath: "/repo/old" }))
      .workspace!;

    const oldThread = (
      await gw.api.createThread({
        projectId,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        initialMessage: "old",
        clientRequestId: "old",
      })
    ).thread!;

    await waitTurn(oldThread.id, 1);
    expect(
      await failure(
        gw.api.prepareThreadRewind({ threadId: oldThread.id, turnId: (await history(oldThread.id)).turns[0]!.id }),
      ),
    ).toContain("Update");
  });

  test("rewind restores fresh attachment bindings, quotes and mention ranges into an editable draft", async () => {
    const thread = await createThread();

    const file = (
      await gw.api.uploadAttachment({
        name: "notes.txt",
        data: new TextEncoder().encode("notes"),
      })
    ).attachment!;

    const sent = (
      await gw.api.sendMessage({
        threadId: thread.id,
        text: "Read [notes.txt]",
        clientRequestId: "rich",
        attachmentIds: [file.id],
        quotes: [{ text: "quoted passage", sourceKind: "agent_message" }],
        mentions: [
          { kind: MentionKind.ATTACHMENT, name: file.id, label: file.name, source: "file", start: 5, end: 16 },
        ],
      })
    ).turn!;

    await waitTurn(thread.id, 4);
    const result = await gw.api.rewindThread({ threadId: thread.id, turnId: sent.id, clientRequestId: "rich-edit" });
    expect(result.draft?.messageText).toBe("Read [notes.txt]");
    expect(result.draft?.quotes[0]?.text).toBe("quoted passage");
    const newFile = result.draft!.attachments[0]!;
    expect(newFile.id).not.toBe(file.id);
    expect(result.draft!.mentions[0]?.name).toBe(newFile.id);
    await gw.api.sendMessage({
      threadId: thread.id,
      text: result.draft!.messageText,
      clientRequestId: "rich-resend",
      attachmentIds: [newFile.id],
      quotes: result.draft!.quotes,
      mentions: result.draft!.mentions,
    });
    await waitTurn(thread.id, 5);
  });

  test("Stop and edit fences the running suffix and cancels pending queue and steers", async () => {
    const thread = await createThread();
    const target = (await history(thread.id)).turns[1]!;
    gw.worker.holdTurns = true;

    try {
      await gw.api.sendMessage({ threadId: thread.id, text: "running", clientRequestId: "running" });
      await eventually(
        () => history(thread.id),
        (snapshot) => snapshot.turns.some((turn) => turn.status === "running"),
      );

      const queued = (await gw.api.sendMessage({ threadId: thread.id, text: "queued", clientRequestId: "queued" }))
        .turn!;

      expect(
        await failure(gw.api.rewindThread({ threadId: thread.id, turnId: target.id, clientRequestId: "without-stop" })),
      ).toContain("Stop");

      const result = await gw.api.rewindThread({
        threadId: thread.id,
        turnId: target.id,
        clientRequestId: "stop-edit",
        stopRunning: true,
      });

      expect(result.status).toBe("completed");
      const after = await history(thread.id);
      expect(after.turns.find((turn) => turn.id === queued.id)?.status).toBe("cancelled");
      expect(after.turns.every((turn) => turn.status !== "running")).toBe(true);
      const old = after.turns.find((turn) => turn.input.text === "running")!;
      gw.worker.emit(thread.id, old.id, { case: "turnStarted", value: { providerTurnRef: "late" } });
      await eventually(
        () => history(thread.id),
        (snapshot) => snapshot.lastSeq > after.lastSeq,
      );
      expect((await history(thread.id)).turns.find((turn) => turn.id === old.id)?.status).toBe("interrupted");
    } finally {
      gw.worker.holdTurns = false;
    }
  });

  test("existing forks retain their prefix and new forks omit messages rewound before their boundary", async () => {
    const thread = await createThread();
    const before = await history(thread.id);

    const fork = (
      await gw.api.createThread({
        forkThreadId: thread.id,
        forkAtTurnId: before.turns[2]!.id,
        provider: Provider.CODEX,
        clientRequestId: "fork-before",
      })
    ).thread!;

    await gw.api.rewindThread({ threadId: thread.id, turnId: before.turns[1]!.id, clientRequestId: "fork-rewind" });
    expect((await history(fork.id)).turns.map((turn) => turn.input.text)).toEqual(["APPLE", "BANANA", "CHERRY"]);
    expect(await failure(gw.api.prepareThreadRewind({ threadId: fork.id, turnId: before.turns[0]!.id }))).toContain(
      "own",
    );

    const sent = (await gw.api.sendMessage({ threadId: thread.id, text: "BLUEBERRY", clientRequestId: "fork-new" }))
      .turn!;

    await waitTurn(thread.id, 4);

    const newer = (
      await gw.api.createThread({
        forkThreadId: thread.id,
        forkAtTurnId: sent.id,
        provider: Provider.CODEX,
        clientRequestId: "fork-after",
      })
    ).thread!;

    expect((await history(newer.id)).turns.map((turn) => turn.input.text)).toEqual(["APPLE", "BLUEBERRY"]);
  });
});
