import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemStatus, Provider, TurnOutcome, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore, SteerStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const answer = "The change is ready.\n\n[Create the PR](canopy:reply)\n\n[Review the diff](canopy:reply)";

describe.skipIf(!dockerAvailable)("authoritative suggested replies (gateway + worker)", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const snapshot = (threadId: string) => gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId)));

  async function running() {
    const threadId = (
      await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, initialMessage: "Prepare it" })
    ).thread!.id;

    const state = await eventually(
      () => snapshot(threadId),
      (state) => state.turns[0]?.status === "running",
    );

    return { threadId, turnId: state.turns[0]!.id };
  }

  async function completed() {
    const source = await running();
    gw.worker.finish(source.threadId, source.turnId, answer);
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.turns[0]?.status === "completed",
    );

    return { ...source, itemId: `msg-${source.turnId}` };
  }

  const send = (source: { threadId: string; itemId: string }, text = "Create the PR") =>
    gw.api.sendMessage({
      threadId: source.threadId,
      replySuggestionItemId: source.itemId,
      text,
      clientRequestId: crypto.randomUUID(),
    });

  const code = (promise: Promise<ui.SendMessageResponse>) =>
    promise.then(
      () => 0,
      (error) => ConnectError.from(error).code,
    );

  beforeAll(async () => {
    gw = await startTestGateway();
    gw.worker.holdTurns = true;
    projectId = (await gw.api.createProject({ name: "Reply suggestions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/replies" }))
      .workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("concurrent choices admit one ordinary user turn; retry replays after newer input", async () => {
    const source = await completed();

    const requests = ["Create the PR", "Review the diff"].map((text) => ({
      threadId: source.threadId,
      replySuggestionItemId: source.itemId,
      text,
      delivery: ui.MessageDelivery.STEER,
      clientRequestId: crypto.randomUUID(),
    }));

    const results = await Promise.allSettled(requests.map((request) => gw.api.sendMessage(request)));
    const accepted = results.findIndex((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejected?.status === "rejected" && ConnectError.from(rejected.reason).code).toBe(Code.FailedPrecondition);
    const request = requests[accepted]!;
    const replay = await gw.api.sendMessage(request);
    expect(replay.steer).toBeUndefined();
    expect(replay.turn?.trigger).toBe("user");
    expect(replay.turn?.inputText).toBe(request.text);
    await eventually(
      async () => gw.worker.started.get(replay.turn!.id)?.text,
      (text) => text === request.text,
    );
    const state = await snapshot(source.threadId);
    expect(state.turns).toHaveLength(2);
    expect(state.items.find((entry) => entry.item?.itemId === source.itemId)?.item?.content).toMatchObject({
      case: "agentMessage",
      value: { text: answer },
    });
    await gw.api.sendMessage({ threadId: source.threadId, text: "Another instruction", clientRequestId: "newer" });
    expect((await gw.api.sendMessage(request)).turn?.id).toBe(replay.turn?.id);
    expect((await snapshot(source.threadId)).turns).toHaveLength(3);
  });

  test("simultaneous retries with one request id admit and deliver once", async () => {
    const source = await completed();

    const request = {
      threadId: source.threadId,
      replySuggestionItemId: source.itemId,
      text: "Create the PR",
      clientRequestId: crypto.randomUUID(),
    };

    const results = await Promise.all([gw.api.sendMessage(request), gw.api.sendMessage(request)]);
    expect(results[0].turn?.id).toBe(results[1].turn?.id);
    await eventually(async () => gw.worker.started.has(results[0].turn!.id), Boolean);
    expect((await snapshot(source.threadId)).turns).toHaveLength(2);
    expect(gw.worker.inputs.get(source.threadId)).toEqual(["Prepare it", "Create the PR"]);
  });

  test("forged text and empty source are rejected without consuming the valid choice", async () => {
    const source = await completed();
    expect(await code(send(source, "Create the PR "))).toBe(Code.InvalidArgument);
    expect(await code(send({ ...source, itemId: "" }))).toBe(Code.InvalidArgument);
    expect(await code(send({ ...source, itemId: "missing" }))).toBe(Code.FailedPrecondition);
    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
    expect((await send(source)).turn?.inputText).toBe("Create the PR");
  });

  test("running, commentary, nested, incomplete and earlier final sources are rejected", async () => {
    const source = await running();

    for (const [itemId, phase, status, parentItemId] of [
      ["early-final", "final_answer", ItemStatus.COMPLETED, ""],
      ["commentary", "commentary", ItemStatus.COMPLETED, ""],
      ["partial", "partial_answer", ItemStatus.COMPLETED, ""],
      ["unphased", "", ItemStatus.COMPLETED, ""],
      ["nested", "final_answer", ItemStatus.COMPLETED, "tool-parent"],
      ["incomplete", "final_answer", ItemStatus.IN_PROGRESS, ""],
    ] as const)
      gw.worker.emit(source.threadId, source.turnId, {
        case: "itemCompleted",
        value: {
          item: { itemId, parentItemId, status, content: { case: "agentMessage", value: { phase, text: answer } } },
        },
      });

    await eventually(
      () => snapshot(source.threadId),
      (state) => state.items.some((entry) => entry.item?.itemId === "incomplete"),
    );
    expect(await code(send({ ...source, itemId: "early-final" }))).toBe(Code.FailedPrecondition);
    gw.worker.finish(source.threadId, source.turnId, answer);
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.turns[0]?.status === "completed",
    );

    for (const itemId of ["early-final", "commentary", "partial", "unphased", "nested", "incomplete"])
      expect(await code(send({ ...source, itemId }))).toBe(Code.FailedPrecondition);
    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
  });

  test("an unphased last message is eligible only after its turn completes", async () => {
    const source = await running();
    gw.worker.emit(source.threadId, source.turnId, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: "unphased-final",
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text: answer } },
        },
      },
    });
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.items.some((entry) => entry.item?.itemId === "unphased-final"),
    );
    expect(await code(send({ ...source, itemId: "unphased-final" }))).toBe(Code.FailedPrecondition);
    gw.worker.emit(source.threadId, source.turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.turns[0]?.status === "completed",
    );
    expect((await send({ ...source, itemId: "unphased-final" })).turn?.inputText).toBe("Create the PR");
  });

  test.each(["commentary", "partial_answer"])("a later %s message invalidates earlier final choices", async (phase) => {
    const source = await completed();
    gw.worker.emit(source.threadId, source.turnId, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: "later",
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { phase, text: answer } },
        },
      },
    });
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.items.some((entry) => entry.item?.itemId === "later"),
    );
    expect(await code(send(source))).toBe(Code.FailedPrecondition);
    expect(await code(send({ ...source, itemId: "later" }))).toBe(Code.FailedPrecondition);
    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
  });

  test.each([
    "> [Create the PR](canopy:reply)",
    "```markdown\n[Create the PR](canopy:reply)\n```",
    "- [Create the PR](canopy:reply)",
    "[!publish](canopy:reply)",
    "[/goal publish](canopy:reply)",
  ])("quoted, nested, code and command labels cannot be forged into a reply (%s)", async (text) => {
    const source = await running();
    gw.worker.finish(source.threadId, source.turnId, text);
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.turns[0]?.status === "completed",
    );

    const label = text.includes("!publish")
      ? "!publish"
      : text.includes("/goal publish")
        ? "/goal publish"
        : "Create the PR";

    expect(await code(send({ ...source, itemId: `msg-${source.turnId}` }, label))).toBe(Code.InvalidArgument);
    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
  });

  test("queued input invalidates choices before that input reaches the worker", async () => {
    const source = await running();
    const queued = await gw.api.sendMessage({ threadId: source.threadId, text: "Wait", clientRequestId: "queue" });
    expect(queued.turn?.status).toBe("queued");
    expect(gw.worker.started.has(queued.turn!.id)).toBe(false);
    gw.worker.finish(source.threadId, source.turnId, answer);
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.turns[0]?.status === "completed",
    );
    expect(await code(send({ ...source, itemId: `msg-${source.turnId}` }))).toBe(Code.FailedPrecondition);
    expect((await snapshot(source.threadId)).turns).toHaveLength(2);
  });

  test("a steer delivered after the final item invalidates its choices even in the same completed turn", async () => {
    const source = await running();
    gw.worker.emit(source.threadId, source.turnId, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: "final",
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { phase: "final_answer", text: answer } },
        },
      },
    });
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.items.some((entry) => entry.item?.itemId === "final"),
    );

    const steer = await gw.api.sendMessage({
      threadId: source.threadId,
      text: "Actually, wait",
      delivery: ui.MessageDelivery.STEER,
      clientRequestId: crypto.randomUUID(),
    });

    await eventually(
      () => snapshot(source.threadId),
      (state) => state.items.some((entry) => entry.item?.itemId === `user-${steer.steer!.id}`),
    );
    gw.worker.emit(source.threadId, source.turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    await eventually(
      () => snapshot(source.threadId),
      (state) => state.turns[0]?.status === "completed",
    );
    expect(await code(send({ ...source, itemId: "final" }))).toBe(Code.FailedPrecondition);
    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
  });

  test("a durable undelivered steer invalidates choices before its fallback turn exists", async () => {
    const turn = await running();
    const source = { ...turn, itemId: `msg-${turn.turnId}` };
    const pump = gw.core.pump.bind(gw.core);

    // Completion is durable before its pump finishes. Hold recovery at this crash boundary.
    const paused = spyOn(gw.core, "pump").mockImplementation((threadId) =>
      threadId === source.threadId ? Promise.resolve() : pump(threadId),
    );

    try {
      gw.worker.finish(source.threadId, source.turnId, answer);
      await eventually(
        () => snapshot(source.threadId),
        (state) => state.turns[0]?.status === "completed",
      );
      // The durable state after a lost steer reply and a turn end, before recovery creates its fallback turn.
      await gw.runtime.runPromise(
        SteerStore.use((s) =>
          s.create({
            threadId: source.threadId,
            turnId: source.turnId,
            text: "Wait for my review",
            userId: gw.userId,
            clientRequestId: crypto.randomUUID(),
            model: "",
            effort: "",
            permissionMode: "",
          }),
        ),
      );
      expect((await snapshot(source.threadId)).turns).toHaveLength(1);
      expect(await code(send(source))).toBe(Code.FailedPrecondition);
      expect((await snapshot(source.threadId)).turns).toHaveLength(1);
    } finally {
      paused.mockRestore();
    }

    await gw.core.pump(source.threadId);
    expect((await snapshot(source.threadId)).turns.map((entry) => entry.input.text)).toEqual([
      "Prepare it",
      "Wait for my review",
    ]);
  });

  test.each([false, true])(
    "a failed steer invalidates only an earlier answer (steer after answer: %s)",
    async (after) => {
      const source = await running();

      const emitAnswer = async () => {
        gw.worker.emit(source.threadId, source.turnId, {
          case: "itemCompleted",
          value: {
            item: {
              itemId: "final",
              status: ItemStatus.COMPLETED,
              content: { case: "agentMessage", value: { phase: "final_answer", text: answer } },
            },
          },
        });
        await eventually(
          () => snapshot(source.threadId),
          (state) => state.items.some((entry) => entry.item?.itemId === "final"),
        );
      };

      gw.worker.handlers.set("steerTurn", (_, reply) =>
        reply(false, { errorCode: "SHELL_FAILED", errorMessage: "fixture command failed" }),
      );

      try {
        if (after) await emitAnswer();

        const sent = await gw.api.sendMessage({
          threadId: source.threadId,
          text: "!pwd",
          delivery: ui.MessageDelivery.STEER,
          clientRequestId: crypto.randomUUID(),
        });

        await eventually(
          () => gw.runtime.runPromise(SteerStore.use((s) => s.steer(sent.steer!.id))),
          (steer) => steer.status === "failed",
        );

        if (!after) await emitAnswer();
        gw.worker.emit(source.threadId, source.turnId, {
          case: "turnFinished",
          value: { outcome: TurnOutcome.COMPLETED },
        });
        await eventually(
          () => snapshot(source.threadId),
          (state) => state.turns[0]?.status === "completed",
        );
        const result = await code(send({ ...source, itemId: "final" }));
        expect(result).toBe(after ? Code.FailedPrecondition : 0);
      } finally {
        gw.worker.handlers.delete("steerTurn");
      }
    },
  );

  test.each(["before", "after", "legacy-before", "legacy-after"])(
    "a dropped background steer expires only older answers (%s)",
    async (timing) => {
      const source = await running();
      const after = timing.endsWith("after");
      const legacy = timing.startsWith("legacy");

      const emitAnswer = async () => {
        gw.worker.emit(source.threadId, source.turnId, {
          case: "itemCompleted",
          value: {
            item: {
              itemId: "final",
              status: ItemStatus.COMPLETED,
              content: { case: "agentMessage", value: { phase: "final_answer", text: answer } },
            },
          },
        });
        await eventually(
          () => snapshot(source.threadId),
          (state) => state.items.some((entry) => entry.item?.itemId === "final"),
        );
      };

      if (after) await emitAnswer();

      const steer = await gw.runtime.runPromise(
        SteerStore.use((s) =>
          s.create({
            threadId: source.threadId,
            turnId: source.turnId,
            text: "A background task ended",
            userId: gw.userId,
            clientRequestId: crypto.randomUUID(),
            model: "",
            effort: "",
            permissionMode: "",
          }),
        ),
      );

      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Released platform notes can retain dropped status after later answers have been generated.
          yield* sql`UPDATE turn_steers SET status='dropped',background_note=true,author_user_id=NULL,
          input=CASE WHEN ${legacy} THEN input-'admittedAfterSeq' ELSE input END WHERE id=${steer.id}::uuid`;
        }),
      );

      if (!after) await emitAnswer();
      gw.worker.emit(source.threadId, source.turnId, {
        case: "turnFinished",
        value: { outcome: TurnOutcome.COMPLETED },
      });
      await eventually(
        () => snapshot(source.threadId),
        (state) => state.turns[0]?.status === "completed",
      );
      expect(await code(send({ ...source, itemId: "final" }))).toBe(after ? Code.FailedPrecondition : 0);
    },
  );

  test("inherited and foreign-thread sources cannot send a choice", async () => {
    const source = await completed();

    const fork = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        parentThreadId: source.threadId,
        fork: true,
        forkThreadId: source.threadId,
        forkAtTurnId: source.turnId,
      })
    ).thread!;

    expect(await code(send({ ...source, threadId: fork.id }))).toBe(Code.FailedPrecondition);
    const other = await completed();

    expect(await code(send({ ...other, itemId: source.itemId }))).toBe(Code.FailedPrecondition);

    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("reply-other@example.test", "Other")),
    );

    const foreign = new GatewayCore({ runtime: gw.runtime, userId: owner, instanceId: "reply-other" });

    try {
      expect(
        await failure(
          foreign.sendMessage(
            create(ui.SendMessageRequestSchema, {
              threadId: source.threadId,
              replySuggestionItemId: source.itemId,
              text: "Create the PR",
              clientRequestId: crypto.randomUUID(),
            }),
          ),
        ),
      ).toContain("thread not found");
    } finally {
      await foreign.stopSweep();
    }

    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
  });

  test("history-only imports cannot continue through a suggested reply", async () => {
    const source = await completed();

    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runId = crypto.randomUUID();
        const itemId = crypto.randomUUID();
        yield* sql`INSERT INTO import_runs(id,owner_user_id,worker_id,status,mode)
        VALUES(${runId}::uuid,${gw.userId}::uuid,${gw.workerId}::uuid,'completed','history')`;
        yield* sql`INSERT INTO import_items(id,run_id,owner_user_id,worker_id,position,agent_cli,root_id,native_id,source_key,snapshot,target,status,thread_id)
        VALUES(${itemId}::uuid,${runId}::uuid,${gw.userId}::uuid,${gw.workerId}::uuid,0,'codex','fixture',${source.threadId},${source.threadId},'{}','{}','done',${source.threadId}::uuid)`;
        yield* sql`INSERT INTO thread_imports(thread_id,owner_user_id,item_id,agent_cli,native_id,mode)
        VALUES(${source.threadId}::uuid,${gw.userId}::uuid,${itemId}::uuid,'codex',${source.threadId},'history')`;
      }),
    );
    expect(await failure(send(source))).toContain("imported as history");
    expect((await snapshot(source.threadId)).turns).toHaveLength(1);
  });
});
