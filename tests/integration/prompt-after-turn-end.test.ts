import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BackgroundTaskKind, ItemStatus, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ThreadEventSchema, TurnOutcome } from "@canopy/contracts";
import { Ingest } from "@canopy/gateway/store";
import { Layer, ManagedRuntime } from "effect";
import { decodeJsonObject } from "../../apps/worker/src/providers/json.ts";
import { answers, eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let projectId = "";
let workspaceId = "";
const logs: string[] = [];

const diagnostics = (threadId: string) =>
  logs.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const parsed = decodeJsonObject(JSON.parse(line));

    return parsed["threadId"] === threadId ? [parsed] : [];
  });

async function snapshot(threadId: string) {
  const updates = await watchUntil(gw.api, threadId, (all) => all.some((u) => u.change.case === "snapshot"));
  const change = updates[0]!.change;

  if (change.case !== "snapshot") throw new Error("Expected a thread snapshot");

  return change.value;
}

async function runningThread(title: string) {
  gw.worker.holdTurns = true;

  const thread = (
    await gw.api.createThread({
      projectId,
      workspaceId,
      title,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.ASK,
      initialMessage: "rebuild the landing page",
    })
  ).thread!;

  const view = await eventually(
    () => snapshot(thread.id),
    (s) => s.turns[0]?.status === "running",
  );

  expect(view.turns[0]?.status).toBe("running");
  const turnId = view.turns[0]!.id;

  // Two processes keep running after the original response, as in the reported incident.
  for (const itemId of ["background-one", "background-two"])
    gw.worker.emit(thread.id, turnId, {
      case: "itemStarted",
      value: {
        item: {
          itemId,
          status: ItemStatus.IN_PROGRESS,
          content: {
            case: "backgroundTask",
            value: {
              taskId: itemId,
              kind: BackgroundTaskKind.PROCESS,
              command: "background work",
              startedInTurnId: turnId,
            },
          },
        },
      },
    });

  return { threadId: thread.id, turnId };
}

async function assertReply(threadId: string, text: string) {
  const view = await eventually(
    () => snapshot(threadId),
    (s) => s.turns.some((t) => t.inputText === text && t.status === "completed"),
  );

  const turn = view.turns.find((t) => t.inputText === text);
  expect(turn?.status).toBe("completed");
  expect(gw.worker.started.get(turn!.id)?.text).toBe(text);
  expect(answers(await watchUntil(gw.api, threadId, (all) => all.length > 0))).toContain(`Echo: ${text}`);
  expect(view.thread?.backgroundTasks).toBe(2);

  return view;
}

describe.skipIf(!dockerAvailable)("prompts at turn completion (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway({ log: (line) => logs.push(line) });
    projectId = (await gw.api.createProject({ name: "Turn boundaries" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app" })).workspace!
      .id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("a prompt immediately after completion starts its own turn despite running background tasks", async () => {
    const { threadId, turnId } = await runningThread("completed");
    gw.worker.finish(threadId, turnId, "Landing page rebuilt");

    const done = await eventually(
      () => snapshot(threadId),
      (s) => s.turns[0]?.status === "completed",
    );

    expect(done.turns[0]?.status).toBe("completed");
    gw.worker.holdTurns = false;
    const text = "publish the page for the team";

    const sent = await gw.api.sendMessage({
      threadId,
      text,
      clientRequestId: "after-completion",
      delivery: ui.MessageDelivery.STEER,
    });

    expect(sent.steer).toBeUndefined();
    expect(sent.turn?.inputText).toBe(text);
    await assertReply(threadId, text);
    expect(diagnostics(threadId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "message_decision",
          delivery: "new_turn",
          reason: "no_running_turn",
          turnId: sent.turn!.id,
        }),
        expect.objectContaining({ event: "turn_started", source: "user", turnId: sent.turn!.id }),
        expect.objectContaining({ event: "turn_finished", source: "user", turnId: sent.turn!.id }),
      ]),
    );
    expect(JSON.stringify(diagnostics(threadId))).not.toContain(text);
  });

  for (const lateAck of [false, true])
    test(`an unconsumed steer becomes a turn when completion ${lateAck ? "precedes" : "follows"} its ACK`, async () => {
      const { threadId, turnId } = await runningThread(`race-${lateAck}`);
      let acknowledge: (() => void) | undefined;
      gw.worker.handlers.set("steerTurn", (_, reply) => {
        acknowledge = () => reply(true);

        if (!lateAck) acknowledge();
        // The harness accepted the RPC but never echoed a userMessage or a steer_dropped notice.
      });

      try {
        const text = `publish a different page (${lateAck})`;

        const sent = await gw.api.sendMessage({
          threadId,
          text,
          clientRequestId: `race-${lateAck}`,
          delivery: ui.MessageDelivery.STEER,
        });

        expect(sent.steer?.turnId).toBe(turnId);
        await eventually(async () => acknowledge !== undefined, Boolean);
        expect(acknowledge).toBeDefined();

        if (!lateAck) {
          const accepted = await eventually(
            () => snapshot(threadId),
            (s) => s.steers[0]?.status === "accepted",
          );

          expect(accepted.steers[0]?.status).toBe("accepted");
        }

        gw.worker.holdTurns = false;
        gw.worker.finish(threadId, turnId, "Landing page rebuilt (again)");

        if (lateAck) {
          const ended = await eventually(
            () => snapshot(threadId),
            (s) => s.turns[0]?.status === "completed",
          );

          expect(ended.turns[0]?.status).toBe("completed");
          acknowledge!();
        }

        const delivered = await assertReply(threadId, text);
        expect(delivered.steers[0]).toMatchObject({
          status: "queued",
          queuedTurnId: delivered.turns.find((t) => t.inputText === text)!.id,
          reason: "the turn ended before the message could join it",
        });

        const retry = await gw.api.sendMessage({
          threadId,
          text,
          clientRequestId: `race-${lateAck}`,
          delivery: ui.MessageDelivery.STEER,
        });

        expect(retry.steer?.id).toBe(sent.steer?.id);
        expect(retry.steer?.status).toBe("queued");
        expect(diagnostics(threadId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event: "message_decision", delivery: "steer", turnId }),
            expect.objectContaining({
              event: "steer_delivery",
              outcome: "requeued",
              steerId: sent.steer!.id,
              queuedTurnId: retry.steer!.queuedTurnId,
            }),
          ]),
        );
        expect(diagnostics(threadId).filter((line) => line["outcome"] === "requeued")).toHaveLength(1);
        await gw.core.pump(threadId);
        expect((await snapshot(threadId)).turns).toHaveLength(2);
      } finally {
        gw.worker.handlers.delete("steerTurn");
      }
    }, 15_000);

  test("a confirmed steer is visible as delivered and is never redelivered after completion", async () => {
    const { threadId, turnId } = await runningThread("consumed");
    const text = "include the deployment instructions";

    const sent = await gw.api.sendMessage({
      threadId,
      text,
      clientRequestId: "consumed",
      delivery: ui.MessageDelivery.STEER,
    });

    const consumed = await eventually(
      () => snapshot(threadId),
      (s) =>
        s.steers[0]?.status === "delivered" &&
        s.items.some((i) => i.item?.content.case === "userMessage" && i.item.content.value.clientId === sent.steer!.id),
    );

    expect(consumed.steers[0]?.status).toBe("delivered");
    expect(gw.worker.steered.get(sent.steer!.id)).toBe(text);
    expect(
      consumed.items.some(
        (i) =>
          i.turnId === turnId &&
          i.item?.content.case === "userMessage" &&
          i.item.content.value.clientId === sent.steer!.id,
      ),
    ).toBe(true);
    gw.worker.holdTurns = false;
    gw.worker.finish(threadId, turnId, "Deployment instructions included");
    await eventually(
      () => snapshot(threadId),
      (s) => s.turns[0]?.status === "completed",
    );
    await gw.core.pump(threadId);
    await gw.core.sweep();
    expect((await snapshot(threadId)).turns).toHaveLength(1);
    expect(diagnostics(threadId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "steer_delivery", outcome: "consumed", steerId: sent.steer!.id }),
      ]),
    );
    expect(diagnostics(threadId).some((line) => line["outcome"] === "requeued")).toBe(false);
  });

  test("the startup sweep recovers an accepted steer if the gateway stopped after committing the turn end", async () => {
    const { threadId, turnId } = await runningThread("sweep");
    gw.worker.handlers.set("steerTurn", (_, reply) => reply(true));

    try {
      const text = "recover this undelivered request";
      await gw.api.sendMessage({ threadId, text, clientRequestId: "sweep", delivery: ui.MessageDelivery.STEER });

      const accepted = await eventually(
        () => snapshot(threadId),
        (s) => s.steers[0]?.status === "accepted",
      );

      expect(accepted.steers[0]?.status).toBe("accepted");

      // Persisted state at a crash between ingest commit and its post-commit pump. The thread is
      // already idle, so ordinary activity/leftover-item recovery would not discover this message.
      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      const persisted = ManagedRuntime.make(Ingest.layer.pipe(Layer.provide(storage.pg.layer)));

      try {
        await persisted.runPromise(
          Ingest.use((i) =>
            i.ingest(gw.workerId, "persisted-before-stop", [
              create(ThreadEventSchema, {
                eventId: Bun.randomUUIDv7(),
                threadId,
                turnId,
                journalSeq: 1n,
                occurredAt: timestampNow(),
                body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
              }),
            ]),
          ),
        );
      } finally {
        await persisted.dispose();
      }

      gw = await startTestGateway({ storage, log: (line) => logs.push(line) });
      expect(await gw.core.sweep()).toContain(threadId);
      const delivered = await assertReply(threadId, text);
      expect(delivered.steers[0]?.status).toBe("queued");
      expect(delivered.turns).toHaveLength(2);
      await gw.core.sweep();
      expect((await snapshot(threadId)).turns).toHaveLength(2);
    } finally {
      gw.worker.handlers.delete("steerTurn");
    }
  });

  test("a child report waking the parent cannot swallow an overlapping user prompt", async () => {
    const { threadId, turnId } = await runningThread("parent");

    const spawned = await gw.worker.callTool({
      threadId,
      turnId,
      tool: "spawn_thread",
      args: { title: "Child", prompt: "finish background work" },
    });

    expect(spawned.isError).toBe(false);

    const child = await eventually(
      async () => gw.worker.created.find((t) => t.threadId !== threadId && t.depth === 1),
      (t) => t !== undefined,
    );

    expect(child).toBeDefined();

    const childView = await eventually(
      () => snapshot(child!.threadId),
      (s) => s.turns[0]?.status === "running",
    );

    gw.worker.finish(threadId, turnId, "Landing page rebuilt");
    await eventually(
      () => snapshot(threadId),
      (s) => s.turns[0]?.status === "completed",
    );
    gw.worker.finish(child!.threadId, childView.turns[0]!.id, "Background work complete");

    const awake = await eventually(
      () => snapshot(threadId),
      (s) => s.turns[1]?.status === "running",
    );

    expect(awake.turns[1]?.trigger).toBe("agent_bus");
    expect(gw.worker.started.get(awake.turns[1]!.id)?.text).toContain("Background work complete");
    gw.worker.handlers.set("steerTurn", (_, reply) => reply(true));

    try {
      const text = "deploy the new page, do not summarize the rebuild";

      const sent = await gw.api.sendMessage({
        threadId,
        text,
        clientRequestId: "wake-race",
        delivery: ui.MessageDelivery.STEER,
      });

      expect(sent.steer?.turnId).toBe(awake.turns[1]!.id);

      const accepted = await eventually(
        () => snapshot(threadId),
        (s) => s.steers[0]?.status === "accepted",
      );

      expect(accepted.steers[0]?.status).toBe("accepted");
      gw.worker.holdTurns = false;
      gw.worker.finish(threadId, awake.turns[1]!.id, "Landing page rebuilt, with background work done");
      const delivered = await assertReply(threadId, text);
      expect(delivered.turns).toHaveLength(3);
      expect(delivered.steers[0]?.status).toBe("queued");
      expect(diagnostics(threadId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "turn_started", source: "agent_bus", turnId: awake.turns[1]!.id }),
          expect.objectContaining({ event: "turn_finished", source: "agent_bus", turnId: awake.turns[1]!.id }),
        ]),
      );
    } finally {
      gw.worker.handlers.delete("steerTurn");
    }
  }, 15_000);
});
