/** Dispatch is visible before the worker starts, while real waiting messages stay manageable. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clone, createFileRegistry, toJson } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import {
  eventually,
  failure,
  SERVICE_TOKEN,
  startTestGateway,
  watchUntil,
  type TestGateway,
} from "./support/gateway.ts";

let gw: TestGateway;
let projectId = "";
let workspaceId = "";

async function idleThread(title: string) {
  const thread = (await gw.api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX })).thread!;
  await eventually(
    () => gw.api.getThread({ threadId: thread.id }),
    (r) => r.thread?.status === "idle",
  );

  return thread;
}

async function snapshot(threadId: string) {
  const [update] = await watchUntil(gw.api, threadId, (updates) => updates.length > 0);

  if (update?.change.case !== "snapshot") throw new Error("missing thread snapshot");

  return update.change.value;
}

/** The same service as a client generated before dispatch fields existed. */
function legacyClient() {
  const file = ui.TurnSchema.file;
  const proto = clone(FileDescriptorProtoSchema, file.proto);

  for (const message of proto.messageType)
    if (message.name === "Turn" || message.name === "Thread")
      message.field = message.field.filter((f) => f.number !== 162);
  const registry = createFileRegistry(proto, (name) => file.dependencies.find((d) => d.proto.name === name));
  const service = registry.getService(ui.GatewayService.typeName)!;

  const method = service.methods.find((m) => m.localName === "sendMessage");

  if (method?.methodKind !== "unary") throw new Error("missing SendMessage");

  const transport = createGrpcTransport({
    baseUrl: gw.grpcUrl,
    interceptors: [
      (next) => (request) => {
        request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

        return next(request);
      },
    ],
  });

  return {
    send: async (request: { threadId: string; text: string; clientRequestId: string }) =>
      (await transport.unary({ ...method, methodKind: "unary" }, undefined, undefined, undefined, request)).message,
    response: method.output,
  };
}

describe.skipIf(!dockerAvailable)("queue dispatch visibility (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Dispatch" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app" })).workspace!
      .id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("an idle send is dispatched in its first event, response and snapshot; a second send still waits", async () => {
    const thread = await idleThread("first dispatch");
    const starts: string[] = [];
    const replies: (() => void)[] = [];
    gw.worker.handlers.set("startTurn", (value, reply) => {
      if (!("turnId" in value)) throw new Error("expected StartTurn");
      starts.push(value.turnId);
      replies.push(() => reply(true));
    });

    const ready = Promise.withResolvers<void>();

    const watching = watchUntil(
      gw.api,
      thread.id,
      (updates) => updates.some((u) => u.change.case === "turn" && u.change.value.dispatched),
      (update) => {
        if (update.change.case === "snapshot") ready.resolve();
      },
    );

    await ready.promise;
    const overviewAbort = new AbortController();

    const overview = gw.api
      .watchOverview({ includeSnapshot: true }, { signal: overviewAbort.signal })
      [Symbol.asyncIterator]();

    await overview.next();

    try {
      const request = { threadId: thread.id, text: "Start immediately", clientRequestId: "idle-dispatch" };
      const sent = (await gw.api.sendMessage(request)).turn!;
      expect([sent.status, sent.dispatched]).toEqual(["queued", true]);
      const updates = await watching;

      const visible = updates.flatMap((u) =>
        u.change.case === "turn" && u.change.value.id === sent.id ? [u.change.value] : [],
      );

      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((t) => t.dispatched)).toBe(true);
      expect((await snapshot(thread.id)).turns.find((t) => t.id === sent.id)?.dispatched).toBe(true);
      expect((await gw.api.getThread({ threadId: thread.id })).thread?.turnStarting).toBe(true);
      let overviewStarting = false;

      while (!overviewStarting) {
        const { value, done } = await overview.next();

        if (done) throw new Error("overview ended before dispatch");
        overviewStarting =
          value.change.case === "thread" && value.change.value.id === thread.id && value.change.value.turnStarting;
      }

      expect(overviewStarting).toBe(true);
      expect((await gw.api.listThreads({ projectId })).threads.find((t) => t.id === thread.id)?.turnStarting).toBe(
        true,
      );
      expect((await gw.api.sendMessage(request)).turn?.dispatched).toBe(true);

      const waiting = await Promise.all(
        ["A", "B"].map(
          async (text) =>
            (await gw.api.sendMessage({ threadId: thread.id, text, clientRequestId: `waiting-${text}` })).turn!,
        ),
      );

      expect(waiting.every((t) => t.status === "queued" && !t.dispatched)).toBe(true);
      await gw.core.pump(thread.id);
      await eventually(
        async () => starts.length,
        (count) => count === 1,
      );
      expect(starts).toEqual([sent.id]);

      expect(await failure(gw.api.editQueuedTurn({ turnId: sent.id, text: "changed", expectedRevision: 0 }))).toContain(
        "already started",
      );
      expect(await failure(gw.api.deleteQueuedTurn({ turnId: sent.id }))).toContain("already started");
      expect(
        await failure(gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [waiting[0]!.id, sent.id] })),
      ).toContain("already started");
      expect(
        (await gw.api.editQueuedTurn({ turnId: waiting[0]!.id, text: "A edited", expectedRevision: 0 })).turn
          ?.dispatched,
      ).toBe(false);

      // A worker ack without turn_started must not send the next message either.
      replies[0]!();
      await gw.core.pump(thread.id);
      expect((await snapshot(thread.id)).turns.filter((t) => t.dispatched).map((t) => t.id)).toEqual([sent.id]);
      expect(starts).toEqual([sent.id]);
    } finally {
      overviewAbort.abort();

      for (const reply of replies) reply();
      gw.worker.handlers.delete("startTurn");
    }
  });

  test("a running turn holds a real queue; dispatch removes its head before turn_started, including steer fallback", async () => {
    gw.worker.holdTurns = true;
    const thread = await idleThread("queue handoff");

    const first = (await gw.api.sendMessage({ threadId: thread.id, text: "Long task", clientRequestId: "busy-first" }))
      .turn!;

    await eventually(
      () => snapshot(thread.id),
      (s) => s.turns.some((t) => t.id === first.id && t.status === "running"),
    );

    const waiting = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Wait for me", clientRequestId: "busy-second" })
    ).turn!;

    expect([waiting.status, waiting.dispatched]).toEqual(["queued", false]);

    gw.worker.steerMode = "not_running";

    const steer = (
      await gw.api.sendMessage({
        threadId: thread.id,
        text: "Steer fallback",
        clientRequestId: "busy-steer",
        delivery: ui.MessageDelivery.STEER,
      })
    ).steer!;

    const fallback = await eventually(
      () => snapshot(thread.id),
      (s) =>
        s.steers.some(
          (x) => x.id === steer.id && x.status === "queued" && s.turns.some((t) => t.id === x.queuedTurnId),
        ),
    );

    const fallbackId = fallback.steers.find((x) => x.id === steer.id)!.queuedTurnId;
    expect(fallback.turns.find((t) => t.id === fallbackId)?.dispatched).toBe(false);

    let reply: (() => void) | undefined;
    gw.worker.handlers.set("startTurn", (_value, answer) => {
      reply = () => answer(true);
    });
    const ready = Promise.withResolvers<void>();

    const watching = watchUntil(
      gw.api,
      thread.id,
      (updates) =>
        updates.some((u) => u.change.case === "turn" && u.change.value.id === waiting.id && u.change.value.dispatched),
      (update) => {
        if (update.change.case === "snapshot") ready.resolve();
      },
    );

    await ready.promise;

    try {
      gw.worker.finish(thread.id, first.id);
      const updates = await watching;

      const dispatched = updates.flatMap((u) =>
        u.change.case === "turn" && u.change.value.id === waiting.id ? [u.change.value] : [],
      );

      expect(dispatched[0]?.dispatched).toBe(true);
      expect(dispatched[0]?.status).toBe("queued");
      const current = await snapshot(thread.id);
      expect(current.turns.find((t) => t.id === waiting.id)?.dispatched).toBe(true);
      expect(current.thread?.turnStarting).toBe(true);
      expect(current.turns.find((t) => t.id === fallbackId)?.dispatched).toBe(false);
      await eventually(async () => reply, Boolean);
    } finally {
      reply?.();
      gw.worker.handlers.delete("startTurn");
      gw.worker.steerMode = "accept";
    }
  });

  test("a dispatched turn accepts steer before turn_started; rejection remains a waiting message", async () => {
    const thread = await idleThread("steer during start");
    let accept = true;
    gw.worker.handlers.set("startTurn", (_value, reply) => reply(true));
    gw.worker.handlers.set("steerTurn", (_value, reply) => {
      if (accept) reply(true);
      else reply(false, { errorCode: "STEER_NOT_RUNNING", errorMessage: "the worker has not started yet" });
    });

    try {
      const first = (
        await gw.api.sendMessage({ threadId: thread.id, text: "Start", clientRequestId: "starting-first" })
      ).turn!;

      expect([first.status, first.dispatched]).toEqual(["queued", true]);

      const accepted = (
        await gw.api.sendMessage({
          threadId: thread.id,
          text: "Join the starting turn",
          clientRequestId: "starting-steer",
          delivery: ui.MessageDelivery.STEER,
        })
      ).steer!;

      expect(accepted.turnId).toBe(first.id);

      const joined = await eventually(
        () => snapshot(thread.id),
        (s) => s.steers.some((x) => x.id === accepted.id && x.status === "accepted"),
      );

      expect(joined.turns).toHaveLength(1);
      expect(joined.turns[0]?.status).toBe("queued");

      accept = false;

      const rejected = (
        await gw.api.sendMessage({
          threadId: thread.id,
          text: "Wait instead",
          clientRequestId: "starting-rejected",
          delivery: ui.MessageDelivery.STEER,
        })
      ).steer!;

      expect(rejected.turnId).toBe(first.id);

      const queued = await eventually(
        () => snapshot(thread.id),
        (s) =>
          s.steers.some(
            (x) => x.id === rejected.id && x.status === "queued" && s.turns.some((t) => t.id === x.queuedTurnId),
          ),
      );

      const fallbackId = queued.steers.find((x) => x.id === rejected.id)!.queuedTurnId;
      const fallback = queued.turns.find((t) => t.id === fallbackId)!;
      expect([fallback.status, fallback.dispatched]).toEqual(["queued", false]);
      expect(queued.turns.find((t) => t.id === first.id)?.dispatched).toBe(true);
    } finally {
      gw.worker.handlers.delete("startTurn");
      gw.worker.handlers.delete("steerTurn");
    }
  });

  test("a client without the new field can send, retry and complete a turn", async () => {
    gw.worker.holdTurns = true;
    const thread = await idleThread("older client");
    const { send, response } = legacyClient();
    const request = { threadId: thread.id, text: "Old client input", clientRequestId: "legacy-dispatch" };
    const sent = await send(request);
    const again = await send(request);
    expect(toJson(response, sent)).toMatchObject({ turn: { inputText: request.text } });
    expect(toJson(response, again)).toMatchObject({ turn: { inputText: request.text } });

    const running = await eventually(
      () => snapshot(thread.id),
      (s) => s.turns.some((t) => t.status === "running"),
    );

    const turn = running.turns[0]!;
    gw.worker.finish(thread.id, turn.id);

    const ended = await eventually(
      () => snapshot(thread.id),
      (s) => s.turns[0]?.status === "completed",
    );

    expect(ended.turns).toHaveLength(1);
    expect(ended.turns[0]?.status).toBe("completed");
  });
});
