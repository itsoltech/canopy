import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemStatus, Provider, ui, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonValue } from "@canopy/domain";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
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

  const receivedReport = async (parent: string, childTurn: string) => {
    const params = [parent, `report:${nodeRef(b.node)}:thread:${childTurn}`];
    await eventually(
      () =>
        a.store.query(
          "SELECT 1 FROM thread_message_receipts WHERE thread_id=$1::uuid AND client_request_id=$2",
          params,
        ),
      (rows) => rows.length === 1,
    );

    return a.store.query(
      `SELECT input->>'message' AS message,input->>'sourceStatus' AS status,input->>'sourceKind' AS kind
       FROM (SELECT input FROM turns WHERE thread_id=$1::uuid AND client_request_id=$2
             UNION ALL SELECT input FROM turn_steers WHERE thread_id=$1::uuid AND client_request_id=$2) delivery`,
      params,
    );
  };

  const tool = (home: ConfigComputer, thread: string, turn: string, args: JsonValue, callId = crypto.randomUUID()) =>
    home.gateway.worker.callTool({ threadId: thread, turnId: turn, tool: "send_message", args, callId });

  const start = async (
    notify = false,
    hops = 0,
    placement: { workspace_id: string; project_id?: string } = { workspace_id: qualifyId(workspaceB, b.node) },
  ) => {
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
        args: { ...placement, title: "Linked child", prompt: "work", notify },
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

  test("project parent keeps its linked scratch child in both overview indexes after close and reconnect", async () => {
    const scratch = (await b.gateway.core.overview()).projects.find((p) => p.kind === "scratch")!;
    const workspace = scratch.workspaces.find((w) => w.workerId === b.gateway.workerId)!;
    const remoteWorkspace = qualifyId(workspace.id, b.node);
    const sourceScratch = (await a.gateway.core.overview()).projects.find((p) => p.kind === "scratch")!;
    expect(sourceScratch.id).not.toBe(scratch.id);
    const pair = await start(false, 0, { workspace_id: remoteWorkspace, project_id: sourceScratch.id });
    const remoteChild = qualifyId(pair.child, b.node);
    const remoteParent = qualifyId(pair.parent, a.node);
    const child = (await b.gateway.api.getThread({ threadId: pair.child })).thread!;
    expect(child).toMatchObject({
      projectId: scratch.id,
      workspaceId: workspace.id,
      parentThreadId: remoteParent,
      spawnedByAgent: true,
      kind: ui.ThreadKind.SIDE,
      rootThreadId: pair.child,
    });

    b.gateway.worker.finish(pair.child, pair.childTurn, "Scratch result");

    const [finished] = await eventually(
      () => turns(b, pair.child),
      (rows) => rows[0]?.status === "completed",
    );

    expect(finished?.status).toBe("completed");

    const closed = await a.gateway.worker.callTool({
      threadId: pair.parent,
      turnId: pair.parentTurn,
      tool: "close_thread",
      args: { thread_id: remoteChild },
    });

    expect(closed.isError).toBe(false);

    const mirrored = await eventually(
      () => a.links.mirror.thread(b.node, pair.child),
      (t) => t?.status === "archived",
      15_000,
    );

    expect(mirrored?.status).toBe("archived");

    const offlineIndex = await a.links.mirror.threads(
      b.node,
      create(ui.ListThreadsRequestSchema, { sidebarOnly: true }),
    );

    expect(offlineIndex.find((t) => t.id === remoteChild)?.parentThreadId).toBe(remoteParent);

    for (const [viewer, childId, parentId] of [
      [a, remoteChild, pair.parent],
      [b, pair.child, remoteParent],
    ] as const) {
      const index = await eventually(
        () => viewer.gateway.api.listThreads({ sidebarOnly: true }),
        (list) => list.threads.some((t) => t.id === childId && t.status === "archived"),
        15_000,
      );

      expect(index.threads.find((t) => t.id === childId)).toMatchObject({
        parentThreadId: parentId,
        lastMessage: "Scratch result",
        status: "archived",
      });

      const stream = viewer.gateway.api.watchOverview(
        { includeSnapshot: true },
        { signal: AbortSignal.timeout(10_000) },
      );

      let snapshot: ui.MobileOverviewSnapshot | undefined;

      for await (const update of stream) {
        if (update.change.case === "mobileSnapshot") {
          snapshot = update.change.value;
          break;
        }
      }

      expect(snapshot?.threads.find((t) => t.id === childId)).toMatchObject({
        parentThreadId: parentId,
        status: "archived",
      });
    }
  }, 60_000);

  test("the parent's spawn card links to the local child when opened on the child's computer", async () => {
    const pair = await start();
    const resultJson = JSON.stringify({ thread_id: qualifyId(pair.child, b.node) });
    const itemId = "spawn-card";

    a.gateway.worker.emit(pair.parent, pair.parentTurn, {
      case: "itemCompleted",
      value: {
        item: {
          itemId,
          status: ItemStatus.COMPLETED,
          content: { case: "agentBusCall", value: { callId: pair.spawnId, toolName: "spawn_thread", resultJson } },
        },
      },
    });

    const stream = b.gateway.api.watchThread(
      { threadId: qualifyId(pair.parent, a.node) },
      { signal: AbortSignal.timeout(10_000) },
    );

    for await (const { change } of stream) {
      const item =
        change.case === "snapshot"
          ? change.value.items.find((entry) => entry.item?.itemId === itemId)?.item
          : change.case === "event" && change.value.event?.body.case === "itemCompleted"
            ? change.value.event.body.value.item
            : undefined;

      if (item?.itemId === itemId && item.content.case === "agentBusCall") {
        expect(item.content.value).toMatchObject({ targetThreadId: pair.child, resultJson });

        return;
      }
    }

    throw new Error("The linked parent's spawn card did not arrive");
  }, 30_000);

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

    expect(await receivedReport(pair.parent, pair.childTurn)).toEqual([
      { message: expected, status: "failed", kind: "report" },
    ]);
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
      a.store.query<{ hops: number; message: string }>(
        "SELECT hops,input->>'message' AS message FROM turns WHERE thread_id=$1::uuid AND input->>'sourceKind'='report'",
        [pair.parent],
      );

    expect(await reports()).toEqual([{ hops: 102, message: "one linked result" }]);
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

  test.each(["completed", "failed"] as const)(
    "a turn with a local user steer sends only its %s status to the remote observer",
    async (status) => {
      const pair = await start(true);

      const accepted = await b.gateway.api.sendMessage({
        threadId: pair.child,
        text: "Local follow-up",
        delivery: ui.MessageDelivery.STEER,
        clientRequestId: crypto.randomUUID(),
      });

      await eventually(
        () => b.store.query("SELECT 1 FROM turn_steers WHERE id=$1::uuid AND status='delivered'", [accepted.steer!.id]),
        (rows) => rows.length === 1,
      );
      const deliveries = spyOn(a.gateway.core.linkedAgents, "deliver");

      try {
        if (status === "failed")
          failAfterCommentary(
            b.gateway.worker,
            pair.child,
            pair.childTurn,
            "Local terminal detail",
            "Local partial text",
            "",
          );
        else b.gateway.worker.finish(pair.child, pair.childTurn, "Combined answer");

        await eventually(
          () => turns(b, pair.child),
          (rows) => rows[0]?.status === status,
        );
        await b.gateway.core.linkedAgents.tick();
        expect(await receivedReport(pair.parent, pair.childTurn)).toEqual([
          { message: "The turn ended.", status, kind: "report" },
        ]);

        const frames = deliveries.mock.calls.filter(
          ([peer, call]) => peer === b.node && call.operation === "report" && call.callId === pair.spawnId,
        );

        expect(frames.length).toBeGreaterThan(0);
        const source = qualifyId(pair.child, b.node);

        for (const [, call, args] of frames) {
          expect(args).toMatchObject({
            title: "",
            message: "The turn ended.",
            text: `[canopy] thread ${source} on ${b.links.hello().name} ended: ${status}.\nThe turn ended.`,
          });
          expect(args).not.toHaveProperty("failure");
          expect(call.sender?.title ?? "").toBe("");
        }
      } finally {
        deliveries.mockRestore();
      }
    },
    30_000,
  );

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
