import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonValue } from "@canopy/domain";
import { qualifyId, splitId } from "@canopy/domain/computers";
import { Schema } from "effect";
import { failAfterCommentary } from "./support/agent-report.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";

const result = (reply: AgentToolResult) => {
  expect(reply.isError).toBe(false);

  return Schema.decodeUnknownSync(Schema.Struct({ thread_id: Schema.String, turn_id: Schema.String }))(
    JSON.parse(reply.resultJson),
  );
};

describe.skipIf(!dockerAvailable)("linked parent-child messages", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let workspaceA: string;
  let projectA: string;
  let workspaceB: string;

  const ready = () =>
    eventually(async () => a.links.reachable().includes(b.node) && b.links.reachable().includes(a.node), Boolean);

  const turns = (home: ConfigComputer, thread: string) =>
    home.store.query<{ id: string; status: string }>(
      "SELECT id,status FROM turns WHERE thread_id=$1::uuid ORDER BY ordinal",
      [thread],
    );

  const tool = (home: ConfigComputer, thread: string, turn: string, args: JsonValue, callId = crypto.randomUUID()) =>
    home.gateway.worker.callTool({ threadId: thread, turnId: turn, tool: "send_message", args, callId });

  const start = async (notify = false, hops = 0) => {
    a.gateway.worker.holdTurns = true;
    b.gateway.worker.holdTurns = true;

    const parent = (
      await a.gateway.api.createThread({
        projectId: projectA,
        workspaceId: workspaceA,
        title: "Linked parent",
        provider: Provider.CODEX,
        initialMessage: "delegate",
      })
    ).thread!.id;

    const [running] = await eventually(
      () => turns(a, parent),
      (rows) => rows[0]?.status === "running",
    );

    const spawnId = crypto.randomUUID();

    if (hops)
      await a.store.query("UPDATE turns SET trigger='background_task',author_user_id=NULL,hops=$2 WHERE id=$1::uuid", [
        running!.id,
        hops,
      ]);

    const spawned = result(
      await a.gateway.worker.callTool({
        threadId: parent,
        turnId: running!.id,
        callId: spawnId,
        tool: "spawn_thread",
        args: { workspace_id: qualifyId(workspaceB, b.node), title: "Linked child", prompt: "work", notify },
      }),
    );

    const child = splitId(spawned.thread_id).id;
    const childTurn = splitId(spawned.turn_id).id;
    await eventually(
      () => turns(b, child),
      (rows) => rows[0]?.status === "running",
    );

    return { parent, parentTurn: running!.id, child, childTurn, spawnId };
  };

  beforeAll(async () => {
    a = await configComputer("Message source");
    b = await configComputer("Message home");
    await pairConfig(a, b);
    await ready();
    projectA = (await a.gateway.api.createProject({ name: "Messages A" })).project!.id;
    workspaceA = (
      await a.gateway.api.createWorkspace({ projectId: projectA, workerId: a.gateway.workerId, rootPath: "/repo" })
    ).workspace!.id;
    const projectB = (await b.gateway.api.createProject({ name: "Messages B" })).project!.id;
    workspaceB = (
      await b.gateway.api.createWorkspace({ projectId: projectB, workerId: b.gateway.workerId, rootPath: "/repo" })
    ).workspace!.id;
  }, 90000);

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  });

  test("omitted delivery joins the running turn in both directions; explicit queue stays queued", async () => {
    const pair = await start();

    for (const [source, target, from, into, active, text] of [
      [a, b, pair.parent, pair.child, pair.childTurn, "parent guidance"],
      [b, a, pair.child, pair.parent, pair.parentTurn, "child progress"],
    ] as const) {
      const sourceTurn = source === a ? pair.parentTurn : pair.childTurn;

      const sent = result(
        await tool(source, from, sourceTurn, { thread_id: qualifyId(into, target.node), prompt: text, notify: false }),
      );

      expect(splitId(sent.turn_id).id).toBe(active);
      await eventually(
        async () => [...target.gateway.worker.steered.values()].some((input) => input.includes(text)),
        Boolean,
      );
      expect(await turns(target, into)).toHaveLength(1);

      const queued = result(
        await tool(source, from, sourceTurn, {
          thread_id: qualifyId(into, target.node),
          prompt: "next task",
          delivery: "queue",
          notify: false,
        }),
      );

      expect(splitId(queued.turn_id).id).not.toBe(active);
      expect((await turns(target, into)).at(-1)?.status).toBe("queued");
    }

    expect(b.gateway.worker.created.find((spec) => spec.threadId === pair.child)?.instructions).toContain(
      "identify the concrete action the recipient must take before you finish",
    );
  });

  test("idle parent and child each receive a new turn", async () => {
    const pair = await start();
    b.gateway.worker.finish(pair.child, pair.childTurn, "first child result");
    await eventually(
      () => turns(b, pair.child),
      (rows) => rows[0]?.status === "completed",
    );

    const next = result(
      await tool(a, pair.parent, pair.parentTurn, {
        thread_id: qualifyId(pair.child, b.node),
        prompt: "new child task",
        notify: false,
      }),
    );

    expect(splitId(next.turn_id).id).not.toBe(pair.childTurn);
    await eventually(
      () => turns(b, pair.child),
      (rows) => rows[1]?.status === "running",
    );
    a.gateway.worker.finish(pair.parent, pair.parentTurn, "parent finished");
    await eventually(
      () => turns(a, pair.parent),
      (rows) => rows[0]?.status === "completed",
    );

    const reply = result(
      await tool(b, pair.child, splitId(next.turn_id).id, {
        thread_id: qualifyId(pair.parent, a.node),
        prompt: "new parent task",
        notify: false,
      }),
    );

    expect(splitId(reply.turn_id).id).not.toBe(pair.parentTurn);
    expect(await turns(a, pair.parent)).toHaveLength(2);
  });

  test.each([
    ["", "", "Turn failed. No error details were recorded."],
    [
      "stream disconnected before completion",
      "Reading configuration",
      "Turn failed: stream disconnected before completion\n\nReading configuration",
    ],
  ])("a linked report explains a failure with stored reason '%s'", async (reason, partial, expected) => {
    const pair = await start(true);
    failAfterCommentary(b.gateway.worker, pair.child, pair.childTurn, reason, partial, "");

    await eventually(
      () => turns(b, pair.child),
      (rows) => rows[0]?.status === "failed",
    );
    await b.gateway.core.linkedAgents.tick();

    const reports = await eventually(
      () =>
        a.store.query<{ message: string }>(
          "SELECT input->>'message' AS message FROM turns WHERE thread_id=$1::uuid AND input->>'sourceKind'='report'",
          [pair.parent],
        ),
      (rows) => rows.length > 0,
    );

    expect(reports).toEqual([{ message: expected }]);
  });

  test("unrelated and detached thread relationships keep the queue default", async () => {
    const pair = await start();
    const other = await start();

    const unrelated = result(
      await tool(a, other.parent, other.parentTurn, {
        thread_id: qualifyId(pair.child, b.node),
        prompt: "unrelated work",
        notify: false,
      }),
    );

    expect(splitId(unrelated.turn_id).id).not.toBe(pair.childTurn);
    await a.store.query("UPDATE computer_agent_calls SET detached=true WHERE call_id=$1::uuid", [pair.spawnId]);
    await b.store.query("UPDATE threads SET remote_parent_detached=true WHERE id=$1::uuid", [pair.child]);

    for (const [source, target, from, into, sourceTurn, active] of [
      [a, b, pair.parent, pair.child, pair.parentTurn, pair.childTurn],
      [b, a, pair.child, pair.parent, pair.childTurn, pair.parentTurn],
    ] as const) {
      const queued = result(
        await tool(source, from, sourceTurn, {
          thread_id: qualifyId(into, target.node),
          prompt: "detached work",
          notify: false,
        }),
      );

      expect(splitId(queued.turn_id).id).not.toBe(active);
      expect((await turns(target, into)).at(-1)?.status).toBe("queued");
    }
  });

  test("long chains preserve hops and deduplicate spawn and follow-up reports after recipient restart", async () => {
    const pair = await start(true, 100);
    expect(await b.store.query("SELECT hops FROM turns WHERE id=$1::uuid", [pair.childTurn])).toEqual([{ hops: 101 }]);
    const followups = [crypto.randomUUID(), crypto.randomUUID()];

    for (const callId of followups) {
      const sent = result(
        await tool(
          a,
          pair.parent,
          pair.parentTurn,
          {
            thread_id: qualifyId(pair.child, b.node),
            prompt: "additional guidance",
          },
          callId,
        ),
      );

      expect(splitId(sent.turn_id).id).toBe(pair.childTurn);
    }

    await eventually(
      () => b.store.query("SELECT id FROM turn_steers WHERE thread_id=$1::uuid AND status='delivered'", [pair.child]),
      (rows) => rows.length === 2,
    );
    b.gateway.worker.finish(pair.child, pair.childTurn, "one linked result");
    await eventually(
      () => turns(b, pair.child),
      (rows) => rows[0]?.status === "completed",
    );
    await b.gateway.core.linkedAgents.tick();
    expect(
      await b.store.query(
        "SELECT call_id FROM computer_agent_calls WHERE target_turn_id=$1::uuid AND direction='incoming' AND report_status='delivered'",
        [pair.childTurn],
      ),
    ).toHaveLength(3);

    const reports = () =>
      a.store.query<{ id: string; hops: number }>(
        "SELECT id,hops FROM turns WHERE thread_id=$1::uuid AND input->>'sourceKind'='report'",
        [pair.parent],
      );

    expect(await reports()).toHaveLength(1);
    expect((await reports())[0]?.hops).toBe(102);
    await a.restart();
    await ready();
    await Promise.all(
      [pair.spawnId, ...followups].map((callId) =>
        b.gateway.core.linkedAgents.call(
          a.node,
          "report",
          { id: pair.parent, kind: "thread", hops: 102, name: "" },
          callId,
          {
            event: pair.childTurn,
            title: "Linked child",
            status: "completed",
            message: "one linked result",
            text: "[canopy] completed\none linked result",
          },
        ),
      ),
    );
    expect(await reports()).toHaveLength(1);
    expect(
      await a.store.query(
        "SELECT thread_id FROM thread_message_receipts WHERE thread_id=$1::uuid AND client_request_id LIKE $2",
        [pair.parent, `report:%:thread:${pair.childTurn}`],
      ),
    ).toHaveLength(1);
  }, 45000);

  test("the 256-step guard reserves the final linked reply and rejects further automated work", async () => {
    const pair = await start();
    const limit = "This automated conversation reached its limit (256 steps). Send a new message to continue.";
    await a.store.query("UPDATE turns SET trigger='background_task',author_user_id=NULL,hops=255 WHERE id=$1::uuid", [
      pair.parentTurn,
    ]);

    const blocked = await tool(a, pair.parent, pair.parentTurn, {
      thread_id: qualifyId(pair.child, b.node),
      prompt: "must not start",
      delivery: "queue",
      notify: false,
    });

    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain(limit);
    expect(
      await failure(
        a.gateway.core.linkedAgents.call(
          b.node,
          "send",
          { id: pair.parent, kind: "thread", hops: 256, name: "" },
          crypto.randomUUID(),
          { target: pair.child, prompt: "must not arrive", delivery: "queue" },
        ),
      ),
    ).toContain(limit);
    expect(await turns(b, pair.child)).toHaveLength(1);

    const report = {
      event: crypto.randomUUID(),
      title: "Linked child",
      status: "completed",
      message: "final reply",
      text: "[canopy] completed\nfinal reply",
    };

    expect(
      await b.gateway.core.linkedAgents.call(
        a.node,
        "report",
        { id: pair.parent, kind: "thread", hops: 256, name: "" },
        pair.spawnId,
        report,
      ),
    ).toEqual({ delivered: true });
    expect(
      await a.store.query("SELECT hops FROM turns WHERE thread_id=$1::uuid AND input->>'sourceKind'='report'", [
        pair.parent,
      ]),
    ).toEqual([{ hops: 256 }]);
    expect(
      await failure(
        b.gateway.core.linkedAgents.call(
          a.node,
          "report",
          { id: pair.parent, kind: "thread", hops: 257, name: "" },
          pair.spawnId,
          { ...report, event: crypto.randomUUID() },
        ),
      ),
    ).toContain(limit);
  });
});
