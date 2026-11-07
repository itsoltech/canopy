import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, ItemStatus, Provider, type AgentToolResult } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { SteerStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const json = (result: AgentToolResult) => {
  expect(result.isError).toBe(false);

  return JSON.parse(result.resultJson);
};

describe.skipIf(!dockerAvailable)("agent bus child messages", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params as never[]);
      }),
    );

  const turns = (id: string) =>
    query<{ id: string; status: string; input: { text: string } }>(
      "SELECT id, status, input FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
      id,
    );

  const steers = (id: string) =>
    query<{ id: string; status: string }>("SELECT id, status FROM turn_steers WHERE agent_call_id = $1::uuid", id);

  const consumed = async (id: string) =>
    (
      await query<{ message_consumed: string | null }>(
        "SELECT message_consumed FROM agent_bus_calls WHERE id = $1::uuid",
        id,
      )
    )[0]!.message_consumed;

  const call = (threadId: string, turnId: string, tool: string, args: JsonValue, callId = Bun.randomUUIDv7()) =>
    gw.worker.callTool({ threadId, turnId, tool, args, callId });

  const start = async (notify = false) => {
    gw.worker.holdTurns = true;

    const parent = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Parent",
        provider: Provider.CODEX,
        initialMessage: "delegate",
      })
    ).thread!;

    const [parentTurn] = await eventually(
      () => turns(parent.id),
      (rows) => rows[0]?.status === "running",
    );

    const spawnId = Bun.randomUUIDv7();

    const child = json(
      await call(parent.id, parentTurn!.id, "spawn_thread", { title: "Child", prompt: "work", notify }, spawnId),
    ) as { thread_id: string; turn_id: string };

    await eventually(
      () => turns(child.thread_id),
      (rows) => rows[0]?.status === "running",
    );

    return {
      parentId: parent.id,
      parentTurn: parentTurn!.id,
      childId: child.thread_id,
      childTurn: child.turn_id,
      spawnId,
    };
  };

  type Pair = Awaited<ReturnType<typeof start>>;

  const send = async (pair: Pair, prompt: string, delivery?: "queue" | "steer") => {
    const id = Bun.randomUUIDv7();

    const result = json(
      await call(
        pair.childId,
        pair.childTurn,
        "send_message",
        {
          thread_id: pair.parentId,
          prompt,
          notify: false,
          ...(delivery && { delivery }),
        },
        id,
      ),
    );

    return { id, result };
  };

  const finish = async (pair: Pair) => {
    gw.worker.holdTurns = false;
    gw.worker.finish(pair.childId, pair.childTurn, "child finished");
    gw.worker.finish(pair.parentId, pair.parentTurn);
    await eventually(
      () => turns(pair.parentId),
      (rows) => rows.every((row) => ["completed", "cancelled"].includes(row.status)),
    );
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Bus messages" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/bus-messages" }))
      .workspace!.id;
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers[0]?.appliedVersion === 2n,
    );
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("a child message ends wait_threads early, with no steer or additional parent input", async () => {
    const pair = await start();
    const waitId = Bun.randomUUIDv7();

    const waiting = call(
      pair.parentId,
      pair.parentTurn,
      "wait_threads",
      { thread_ids: [pair.childId], until: "all", timeout_seconds: 10 },
      waitId,
    );

    await eventually(
      () => query("SELECT id FROM agent_bus_calls WHERE id = $1::uuid AND status = 'requested'", waitId),
      (rows) => rows.length === 1,
    );
    const sent = await send(pair, "Run the DB check now");
    const result = json(await waiting);
    expect(result).toMatchObject({
      done: false,
      messages: [{ call_id: sent.id, thread_id: pair.childId, text: "Run the DB check now" }],
    });
    expect(await consumed(sent.id)).toBe("consumed_by_wait");
    expect(await steers(sent.id)).toHaveLength(0);
    expect(gw.worker.started.has(sent.result.turn_id)).toBe(false);
    // Tool replay returns the same observed message without reviving its input.
    expect(
      json(await call(pair.parentId, pair.parentTurn, "wait_threads", { thread_ids: [pair.childId] }, waitId)),
    ).toEqual(result);
    await finish(pair);
    expect((await turns(pair.parentId)).map((row) => row.status)).toEqual(["completed", "cancelled"]);
  });

  test("a final result racing the wait returns through the wait without a duplicate report steer", async () => {
    const pair = await start(true);
    const waitId = Bun.randomUUIDv7();

    const waiting = call(
      pair.parentId,
      pair.parentTurn,
      "wait_threads",
      { thread_ids: [pair.childId], timeout_seconds: 10 },
      waitId,
    );

    await eventually(
      () => query("SELECT id FROM agent_bus_calls WHERE id = $1::uuid AND status = 'requested'", waitId),
      (rows) => rows.length === 1,
    );
    const sent = await send(pair, "Racing final result");
    gw.worker.finish(pair.childId, pair.childTurn, "Racing final result");
    const result = json(await waiting);
    expect(result.messages).toMatchObject([{ call_id: sent.id, text: "Racing final result" }]);
    expect(await consumed(sent.id)).toBe("consumed_by_wait");
    expect(await steers(sent.id)).toHaveLength(0);
    expect(await query("SELECT id FROM turn_steers WHERE notification_call_id = $1::uuid", pair.spawnId)).toHaveLength(
      0,
    );
    await finish(pair);
    expect(gw.worker.started.has(sent.result.turn_id)).toBe(false);
  });

  test("cancelling wait_threads releases delivery without consuming later messages", async () => {
    const pair = await start();
    const waitId = Bun.randomUUIDv7();
    const args = { thread_ids: [pair.childId], timeout_seconds: 10 };
    const waiting = call(pair.parentId, pair.parentTurn, "wait_threads", args, waitId);
    await eventually(
      () => query("SELECT id FROM agent_bus_calls WHERE id = $1::uuid AND status = 'requested'", waitId),
      (rows) => rows.length === 1,
    );
    await gw.core.bus.handle(
      create(AgentToolCallSchema, {
        callId: waitId,
        threadId: pair.parentId,
        turnId: pair.parentTurn,
        toolName: "wait_threads",
        argumentsJson: JSON.stringify(args),
        cancelled: true,
      }),
    );
    const sent = await send(pair, "Message after cancelled wait");
    expect(sent.result.delivery).toBe("steer");
    await eventually(
      () => steers(sent.id),
      (rows) => rows[0]?.status === "delivered",
    );
    expect((await waiting).isError).toBe(true);
    expect(await consumed(sent.id)).toBeNull();
    await finish(pair);
    expect(await turns(pair.parentId)).toHaveLength(1);
  });

  test("default child delivery steers a normal parent turn; entered input remains in history", async () => {
    const pair = await start();
    const sent = await send(pair, "Use the new migration");
    expect(sent.result).toMatchObject({ delivery: "steer", turn_id: pair.parentTurn });

    const [steer] = await eventually(
      () => steers(sent.id),
      (rows) => rows[0]?.status === "delivered",
    );

    expect(gw.worker.started.get(steer!.id)?.text).toContain("Use the new migration");
    json(await call(pair.parentId, pair.parentTurn, "get_thread", { thread_id: pair.childId }));
    expect(await consumed(sent.id)).toBeNull();
    await finish(pair);
    expect(await turns(pair.parentId)).toHaveLength(1);
  });

  test("idle parent receives a queued turn with the actual send time", async () => {
    const pair = await start();
    gw.worker.finish(pair.parentId, pair.parentTurn);
    await eventually(
      () => turns(pair.parentId),
      (rows) => rows[0]?.status === "completed",
    );
    const sent = await send(pair, "Need a follow-up");
    await eventually(
      () => turns(pair.parentId),
      (rows) => rows[1]?.status === "running",
    );
    const text = gw.worker.started.get(sent.result.turn_id)!.text;
    expect(text).toMatch(/sent at \d{4}-\d\d-\d\dT/);
    expect(text).not.toContain("while your previous turn was running");
    gw.worker.finish(pair.parentId, sent.result.turn_id);
    await finish(pair);
  });

  test("explicit queue stays queued while busy, carries timing context, and is consumed by get_thread", async () => {
    const pair = await start();
    const sent = await send(pair, "Queued update", "queue");
    expect(await steers(sent.id)).toHaveLength(0);
    const queued = (await turns(pair.parentId))[1]!;
    expect(queued.input.text).toContain("queued while your previous turn was running");
    const result = json(await call(pair.parentId, pair.parentTurn, "get_thread", { thread_id: pair.childId }));
    expect(result.messages).toMatchObject([{ call_id: sent.id, text: "Queued update" }]);
    expect(await consumed(sent.id)).toBe("consumed_by_read");
    await finish(pair);
    expect(gw.worker.started.has(queued.id)).toBe(false);
  });

  for (const delivery of ["entered", "queued", "waited"] as const) {
    test(`explicit final message (${delivery}) and completion notification deliver the text once`, async () => {
      const pair = await start(true);
      const text = `All DB checks passed (${delivery})`;
      const sent = await send(pair, text, delivery === "entered" ? undefined : "queue");

      if (delivery === "entered")
        await eventually(
          () => steers(sent.id),
          (rows) => rows[0]?.status === "delivered",
        );

      if (delivery === "waited")
        expect(
          json(
            await call(pair.parentId, pair.parentTurn, "wait_threads", {
              thread_ids: [pair.childId],
              timeout_seconds: 1,
            }),
          ).messages,
        ).toMatchObject([{ text }]);
      gw.worker.finish(pair.childId, pair.childTurn, text);
      await eventually(
        () =>
          query<{ notify_status: string }>(
            "SELECT notify_status FROM agent_bus_calls WHERE id = $1::uuid",
            pair.spawnId,
          ),
        (rows) => rows[0]?.notify_status !== "pending" && rows[0]?.notify_status !== "steering",
      );
      const inputs = [...gw.worker.started.values()].filter((input) => input.text.includes(text));
      expect(inputs).toHaveLength(delivery === "waited" ? 0 : 1);
      await finish(pair);
    });
  }

  test("read_thread consumes only a page covering the send, and prevents a late steer fallback", async () => {
    const pair = await start();
    gw.worker.handlers.set("steerTurn", (_value, reply) => reply(true));

    try {
      const sent = await send(pair, "Read this update");

      const [steer] = await eventually(
        () => steers(sent.id),
        (rows) => rows[0]?.status === "accepted",
      );

      const empty = json(
        await call(pair.parentId, pair.parentTurn, "read_thread", { thread_id: pair.childId, after_seq: 999999 }),
      );

      expect(empty.messages).toEqual([]);
      expect(await consumed(sent.id)).toBeNull();
      gw.worker.emit(pair.childId, pair.childTurn, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: `tool-${sent.id.slice(-6)}`,
            status: ItemStatus.COMPLETED,
            content: {
              case: "toolCall",
              value: {
                name: "send_message",
                inputJson: JSON.stringify({ thread_id: pair.parentId, prompt: "Read this update" }),
              },
            },
          },
        },
      });
      await eventually(
        () => query("SELECT item_id FROM thread_items WHERE thread_id = $1::uuid AND type = 'tool_call'", pair.childId),
        (rows) => rows.length === 1,
      );

      const page = json(
        await call(pair.parentId, pair.parentTurn, "read_thread", { thread_id: pair.childId, view: "items" }),
      );

      expect(page.messages).toMatchObject([{ call_id: sent.id, text: "Read this update" }]);
      expect(await consumed(sent.id)).toBe("consumed_by_read");
      expect(
        (await gw.runtime.runPromise(SteerStore.use((s) => s.queue(steer!.id, "late refusal")))).turn,
      ).toBeUndefined();
      await finish(pair);
      expect(await turns(pair.parentId)).toHaveLength(1);
    } finally {
      gw.worker.handlers.delete("steerTurn");
    }
  });

  for (const mode of ["not_running", "drop"] as const) {
    test(`default ancestor steer (${mode}) falls back once with timing context`, async () => {
      const pair = await start();
      gw.worker.steerMode = mode;

      try {
        const sent = await send(pair, `Fallback ${mode}`);
        expect(sent.result.delivery).toBe("steer");
        await eventually(
          () => steers(sent.id),
          (rows) => rows[0]?.status === "queued",
        );
        const queued = (await turns(pair.parentId))[1]!;
        expect(queued.input.text).toContain("queued while your previous turn was running");
        expect(queued.input.text).toContain("sent at ");
        await finish(pair);
        expect(gw.worker.started.get(queued.id)?.text).toBe(queued.input.text);
        expect(await turns(pair.parentId)).toHaveLength(2);
      } finally {
        gw.worker.steerMode = "accept";
      }
    });
  }

  test("read_thread messages view consumes the matching final message, including its full text", async () => {
    const pair = await start();
    const text = "DB result: " + "details ".repeat(1500);
    const sent = await send(pair, text, "queue");
    gw.worker.finish(pair.childId, pair.childTurn, text);
    await eventually(
      () => turns(pair.childId),
      (rows) => rows[0]?.status === "completed",
    );
    const page = json(await call(pair.parentId, pair.parentTurn, "read_thread", { thread_id: pair.childId }));
    expect(page.messages).toMatchObject([{ call_id: sent.id, text }]);
    expect(await consumed(sent.id)).toBe("consumed_by_read");
    await finish(pair);
    expect(gw.worker.started.has(sent.result.turn_id)).toBe(false);
  });

  test("a different final result is still reported after a mid-task message", async () => {
    const pair = await start(true);
    const sent = await send(pair, "Please run the DB checks");
    await eventually(
      () => steers(sent.id),
      (rows) => rows[0]?.status === "delivered",
    );
    gw.worker.finish(pair.childId, pair.childTurn, "DB checks passed; migration ready");
    await eventually(
      () =>
        query(
          "SELECT id FROM turn_steers WHERE notification_call_id = $1::uuid AND status = 'delivered'",
          pair.spawnId,
        ),
      (rows) => rows.length === 1,
    );
    expect(
      [...gw.worker.started.values()].filter((input) => input.text.includes("DB checks passed; migration ready")),
    ).toHaveLength(1);
    await finish(pair);
    expect(await turns(pair.parentId)).toHaveLength(1);
  });

  test("wait_threads also receives messages from a waited-on sibling", async () => {
    const pair = await start();

    const sibling = json(
      await call(pair.parentId, pair.parentTurn, "spawn_thread", {
        title: "Sibling",
        prompt: "other work",
        notify: false,
      }),
    ) as { thread_id: string; turn_id: string };

    await eventually(
      () => turns(sibling.thread_id),
      (rows) => rows[0]?.status === "running",
    );
    const waitId = Bun.randomUUIDv7();

    const waiting = call(
      pair.childId,
      pair.childTurn,
      "wait_threads",
      { thread_ids: [sibling.thread_id], timeout_seconds: 10 },
      waitId,
    );

    await eventually(
      () => query("SELECT id FROM agent_bus_calls WHERE id = $1::uuid AND status = 'requested'", waitId),
      (rows) => rows.length === 1,
    );

    const sent = json(
      await call(sibling.thread_id, sibling.turn_id, "send_message", {
        thread_id: pair.childId,
        prompt: "Use my fixture",
        notify: false,
      }),
    );

    expect(json(await waiting)).toMatchObject({
      done: false,
      messages: [{ thread_id: sibling.thread_id, text: "Use my fixture" }],
    });
    expect(gw.worker.started.has(sent.turn_id)).toBe(false);
    gw.worker.finish(sibling.thread_id, sibling.turn_id);
    await finish(pair);
    expect((await turns(pair.childId)).map((row) => row.status)).toEqual(["completed", "cancelled"]);
  });

  test("a parent's read after gateway restart durably cancels a pending message and replay", async () => {
    const pair = await start();
    const sent = await send(pair, "Already handled after reconnect", "queue");
    gw.worker.link.close();
    await eventually(
      async () => gw.core.online.has(gw.workerId),
      (online) => !online,
    );
    const fresh = new GatewayCore({ runtime: gw.runtime, instanceId: "restart-messages", userId: gw.userId });

    const request = create(AgentToolCallSchema, {
      callId: Bun.randomUUIDv7(),
      threadId: pair.parentId,
      turnId: pair.parentTurn,
      toolName: "get_thread",
      argumentsJson: JSON.stringify({ thread_id: pair.childId }),
    });

    const result = json(await fresh.bus.handle(request));
    expect(result.messages).toMatchObject([{ call_id: sent.id }]);
    expect(await consumed(sent.id)).toBe("consumed_by_read");
    const again = new GatewayCore({ runtime: gw.runtime, instanceId: "restart-messages-again", userId: gw.userId });
    expect(json(await again.bus.handle(request))).toEqual(result);
    await again.sweep();
    expect((await turns(pair.parentId)).map((row) => row.status)).toEqual(["running", "cancelled"]);
    expect(gw.worker.started.has(sent.result.turn_id)).toBe(false);
    await fresh.link.shutdown();
    await again.link.shutdown();
  });
});
