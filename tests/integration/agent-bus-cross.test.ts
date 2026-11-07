/**
 * Subagents of any provider and messages between any threads of a user (docs/agent-bus.md) on PostgreSQL, with
 * scripted workers: "studio" has Codex and Claude (both catalogs), the default "laptop" only Codex.
 * - spawn_thread picks any provider instance + model + effort the user could pick there (Codex -> Claude, Claude -> Codex),
 *   validated like a user's thread; list_agents lists them,
 * - send_message reaches any thread of the same owner (other trees, projects, workers), queue or steer, with hops and
 *   notify across trees; control stays with descendants; another owner's threads stay invisible,
 * - the UI sees who sent a turn or steer (AgentSender) and where a call went (BusDelivery, snapshot and live).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  eventually,
  SCRIPTED_MODELS,
  startTestGateway,
  watchUntil,
  type ScriptedWorker,
  type TestGateway,
} from "./support/gateway.ts";

let gw: TestGateway;
let studio: ScriptedWorker;
let projectId = "";
let studioWorkspace = "";
let laptopProject = "";
let laptopWorkspace = "";

const CLAUDE_MODELS = {
  provider: Provider.CLAUDE,
  profileId: "native",
  models: [
    {
      id: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      isDefault: true,
      efforts: ["low", "medium", "high", "max"],
    },
    { id: "haiku", displayName: "Haiku", efforts: [] },
  ],
};

const json = (result: AgentToolResult) => JSON.parse(result.content) as JsonObject;

const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );

const turns = (threadId: string) =>
  query<{ id: string; ordinal: number; status: string; trigger: string; hops: number; text: string }>(
    "SELECT id, ordinal, status, trigger, hops, input->>'text' AS text FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );

const settled = (threadId: string) =>
  eventually(
    () => turns(threadId),
    (t) => t.length > 0 && t.every((x) => x.status !== "running" && x.status !== "queued"),
  );

const snapshot = async (threadId: string) => {
  const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
  const first = updates.find((u) => u.change.case === "snapshot")!.change;

  return (first.case === "snapshot" ? first.value : undefined)!;
};

async function mainThread(
  title: string,
  provider: Provider,
  where: { projectId: string; workspaceId: string } = { projectId, workspaceId: studioWorkspace },
) {
  const thread = (
    await gw.api.createThread({
      ...where,
      title,
      provider,
      permissionMode: PermissionMode.ASK,
      initialMessage: "hello",
    })
  ).thread!;

  await eventually(
    () => turns(thread.id),
    (t) => t[0]?.status === "completed",
  );

  return thread;
}

describe.skipIf(!dockerAvailable)("agent bus across providers and trees (gateway + scripted workers)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const added = await gw.addWorker("studio", ["/studio"]);
    studio = await gw.connect(added.workerId, added.credential, undefined, {
      claude: true,
      models: [...SCRIPTED_MODELS, CLAUDE_MODELS],
    });
    await eventually(
      async () => (await gw.api.getOverview({})).workers.find((w) => w.id === added.workerId),
      (w) =>
        !!w && w.appliedVersion > 0n && w.providerInstances.some((i) => i.harness === Provider.CLAUDE && i.available),
    );
    projectId = (await gw.api.createProject({ name: "Cross" })).project!.id;
    studioWorkspace = (
      await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: "/studio/app", label: "" })
    ).workspace!.id;
    laptopProject = (await gw.api.createProject({ name: "Elsewhere" })).project!.id;
    laptopWorkspace = (
      await gw.api.createWorkspace({
        projectId: laptopProject,
        workerId: gw.workerId,
        rootPath: "/repo/other",
        label: "",
      })
    ).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  }, 30_000);

  test("list_agents: the worker's available instances with their models; a worker without Claude lists Codex only", async () => {
    const codex = await mainThread("Codex lead", Provider.CODEX);

    const listed = json(await studio.callTool({ threadId: codex.id, tool: "list_agents", args: {} })) as {
      you: { provider: string };
      agents: { provider: string; models: { id: string; name?: string; efforts?: string[]; default?: boolean }[] }[];
    };

    expect(listed.you.provider).toBe("codex/native");
    expect(listed.agents.map((a) => a.provider)).toEqual(["claude/native", "codex/native"]);
    expect(listed.agents[0]?.models).toEqual([
      { id: "opus", name: "Opus", efforts: ["low", "medium", "high", "max"], default: true },
      { id: "haiku", name: "Haiku" },
    ]);

    const laptop = await mainThread("Laptop lead", Provider.CODEX, {
      projectId: laptopProject,
      workspaceId: laptopWorkspace,
    });

    const there = json(await gw.worker.callTool({ threadId: laptop.id, tool: "list_agents", args: {} })) as {
      agents: { provider: string }[];
    };

    expect(there.agents.map((a) => a.provider)).toEqual(["codex/native"]);

    const refused = await gw.worker.callTool({
      threadId: laptop.id,
      tool: "spawn_thread",
      args: { title: "x", prompt: "y", provider: "claude" },
    });

    expect([refused.isError, refused.content]).toEqual([
      true,
      "claude/native is not available on this worker: claude CLI not found",
    ]);
  }, 30_000);

  test("Codex -> Claude: the subagent runs on Claude with the chosen model and effort; its task names the sender, the report comes back", async () => {
    const lead = await mainThread("Codex orchestrator", Provider.CODEX);

    const spawned = await studio.callTool({
      threadId: lead.id,
      tool: "spawn_thread",
      args: { title: "Claude helper", prompt: "Summarize README", provider: "claude", model: "opus", effort: "high" },
    });

    expect(spawned.isError).toBe(false);
    const result = json(spawned) as { thread_id: string; provider: string; model: string; effort: string };
    expect([result.provider, result.model, result.effort]).toEqual(["claude/native", "opus", "high"]);
    expect(await studio.createdThread(result.thread_id)).toMatchObject({
      provider: Provider.CLAUDE,
      providerProfileId: "",
      model: "opus",
      cwd: "/studio/app",
      depth: 1,
    });
    const child = (await gw.api.getThread({ threadId: result.thread_id })).thread!;
    expect([child.provider, child.model, child.effort, child.parentThreadId]).toEqual([
      Provider.CLAUDE,
      "opus",
      "high",
      lead.id,
    ]);
    expect(studio.turnSettings.get((await settled(child.id))[0]!.id)).toEqual({ model: "opus", effort: "high" });

    // The child's task shows who sent it (the Codex lead, with the model its turn ran); the lead's report names the Claude child.
    const childTurn = (await snapshot(child.id)).turns[0]!;
    expect(childTurn.sourceKind).toBe("task");
    expect(childTurn.sender).toMatchObject({
      threadId: lead.id,
      title: "Codex orchestrator",
      provider: Provider.CODEX,
      projectId,
      workerId: child.workerId,
    });

    const leadTurns = await eventually(
      () => turns(lead.id),
      (t) => t.length === 2 && t[1]?.status === "completed",
    );

    expect(leadTurns[1]).toMatchObject({ trigger: "agent_bus", hops: 2 });
    const report = (await snapshot(lead.id)).turns[1]!;
    expect([report.sourceKind, report.sender?.provider, report.sender?.title]).toEqual([
      "report",
      Provider.CLAUDE,
      "Claude helper",
    ]);
    // The lead's delivery: queued as the child's first turn, completed.
    const delivery = (await snapshot(lead.id)).busDeliveries.find((d) => d.targetThreadId === child.id);
    expect(delivery).toMatchObject({ delivery: "queue", status: "completed", targetTurnId: childTurn.id });
    // The child's settled state for the subagents panel.
    expect((await gw.api.getThread({ threadId: child.id })).thread?.lastTurnStatus).toBe("completed");
  }, 30_000);

  test("Claude -> Codex (provider's default model and effort), Claude -> Claude and Codex -> Codex", async () => {
    const lead = await mainThread("Claude orchestrator", Provider.CLAUDE);

    const codex = json(
      await studio.callTool({
        threadId: lead.id,
        tool: "spawn_thread",
        args: { title: "Codex helper", prompt: "Run the tests", provider: "codex/native", notify: false },
      }),
    );

    expect([codex["provider"], codex["model"], codex["effort"]]).toEqual(["codex/native", "gpt-6.1-sol", "low"]);
    expect(await studio.createdThread(String(codex["thread_id"]))).toMatchObject({
      provider: Provider.CODEX,
      model: "gpt-6.1-sol",
    });

    const same = json(
      await studio.callTool({
        threadId: lead.id,
        tool: "spawn_thread",
        args: { title: "Claude twin", prompt: "x", notify: false, model: "haiku" },
      }),
    );

    expect([same["provider"], same["model"], same["effort"]]).toEqual(["claude/native", "haiku", ""]);
    const codexLead = await mainThread("Codex twin lead", Provider.CODEX);

    const twin = json(
      await studio.callTool({
        threadId: codexLead.id,
        tool: "spawn_thread",
        args: { title: "Codex twin", prompt: "x", notify: false, provider: "codex", effort: "high" },
      }),
    );

    expect([twin["provider"], twin["effort"]]).toEqual(["codex/native", "high"]);

    for (const id of [codex["thread_id"], same["thread_id"], twin["thread_id"]] as string[]) await settled(id);
  }, 30_000);

  test("validated like a user's thread: the catalog's models and efforts; fork keeps the provider", async () => {
    const lead = await mainThread("Validator", Provider.CODEX);

    const call = (args: JsonObject) =>
      studio.callTool({
        threadId: lead.id,
        tool: "spawn_thread",
        args: { title: "x", prompt: "y", notify: false, ...args },
      });

    expect((await call({ provider: "claude", model: "gpt-5.5" })).content).toBe(
      'claude/native does not offer the model "gpt-5.5"; call list_agents for its models',
    );
    expect((await call({ provider: "claude", model: "opus", effort: "xhigh" })).content).toBe(
      'Opus supports the reasoning efforts low, medium, high, max, not "xhigh"',
    );
    expect((await call({ provider: "gemini" })).content).toContain('no provider "gemini" on this worker');
    expect((await call({ provider: "claude", fork: true })).content).toBe(
      "fork keeps the provider: codex cannot fork into claude",
    );
    expect((await call({ agent: "reviewer" })).content).toContain("agent");

    // Refusals start nothing.
    const children = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM threads WHERE parent_thread_id = $1::uuid",
      lead.id,
    );

    expect(children[0]?.n).toBe(0);
  }, 30_000);

  test("steer into a child on the other provider (Codex -> Claude and Claude -> Codex); the sender's card follows the turn", async () => {
    for (const [leadProvider, childProvider] of [
      [Provider.CODEX, "claude"],
      [Provider.CLAUDE, "codex"],
    ] as const) {
      const lead = await mainThread(`Steering ${childProvider}`, leadProvider);
      studio.holdTurns = true;

      const child = json(
        await studio.callTool({
          threadId: lead.id,
          tool: "spawn_thread",
          args: { title: `Held ${childProvider}`, prompt: "Work long", provider: childProvider, notify: false },
        }),
      );

      const childId = child["thread_id"] as string;

      const running = await eventually(
        () => turns(childId),
        (t) => t[0]?.status === "running",
      );

      const sent = json(
        await studio.callTool({
          threadId: lead.id,
          tool: "send_message",
          args: { thread_id: childId, prompt: "Also add tests", delivery: "steer", notify: false },
        }),
      );

      expect([sent["delivery"], sent["turn_id"]]).toEqual(["steer", running[0]!.id]);

      const steered = await eventually(
        async () => [...studio.steered.values()].find((t) => t.includes(`"Steering ${childProvider}"`)),
        (t) => t !== undefined,
      );

      expect(steered).toContain("Also add tests");
      // The steer carries its sender for the child's timeline.
      const steer = (await snapshot(childId)).steers.find((s) => s.text === "Also add tests");
      expect(steer?.sender).toMatchObject({ threadId: lead.id, provider: leadProvider });
      studio.holdTurns = false;
      studio.finish(childId, running[0]!.id);
      await settled(childId);

      const delivery = await eventually(
        async () => (await snapshot(lead.id)).busDeliveries.find((d) => d.callId !== "" && d.delivery === "steer"),
        (d) => d?.status === "completed",
      );

      expect(delivery).toMatchObject({ targetThreadId: childId, targetTurnId: running[0]!.id, status: "completed" });
    }
  }, 30_000);

  test("send_message to another tree, project and worker: queued like a human's message, marked as an agent's, hops and notify across trees", async () => {
    const sender = await mainThread("Studio agent", Provider.CODEX);

    const target = await mainThread("Laptop thread", Provider.CODEX, {
      projectId: laptopProject,
      workspaceId: laptopWorkspace,
    });

    // Found by title among all of the user's threads, with its project and worker.
    const found = json(
      await studio.callTool({ threadId: sender.id, tool: "list_threads", args: { scope: "all", query: "laptop thr" } }),
    ) as {
      threads: { thread_id: string; project: string; worker: string; provider: string }[];
    };

    expect(found.threads[0]).toMatchObject({
      thread_id: target.id,
      project: "Elsewhere",
      worker: "laptop",
      provider: "codex/native",
    });

    // Live: the sender's card hears where its message is (queued, running, completed).
    const watching = watchUntil(gw.api, sender.id, (u) =>
      u.some(
        (x) =>
          x.change.case === "busDelivery" &&
          x.change.value.targetThreadId === target.id &&
          x.change.value.status === "completed",
      ),
    );

    const sent = await studio.callTool({
      threadId: sender.id,
      tool: "send_message",
      args: { thread_id: target.id, prompt: "Please rebase your branch" },
    });

    expect(sent.isError).toBe(false);

    const targetTurns = await eventually(
      () => turns(target.id),
      (t) => t.length === 2 && t[1]?.status === "completed",
    );

    expect(targetTurns[1]).toMatchObject({ trigger: "agent_bus", hops: 1 });
    expect(targetTurns[1]?.text).toContain('Message from the thread "Studio agent"');
    expect(targetTurns[1]?.text).toContain("an agent outside your thread tree");
    const turn = (await snapshot(target.id)).turns[1]!;
    expect([turn.sourceKind, turn.messageText]).toEqual(["message", "Please rebase your branch"]);
    expect(turn.sender).toMatchObject({
      threadId: sender.id,
      title: "Studio agent",
      provider: Provider.CODEX,
      projectId,
    });
    expect(turn.sender?.workerId).not.toBe(gw.workerId); // the sender lives on the studio worker

    // notify across trees: the sender gets the target's reply as a report turn.
    const senderTurns = await eventually(
      () => turns(sender.id),
      (t) => t.length === 2 && t[1]?.status === "completed",
    );

    expect(senderTurns[1]).toMatchObject({ trigger: "agent_bus", hops: 2 });
    expect(senderTurns[1]?.text).toContain(`"Laptop thread" (thread_id: ${target.id}) finished a turn: completed`);
    const live = (await watching).flatMap((u) => (u.change.case === "busDelivery" ? [u.change.value.status] : []));
    expect(live).toContain("completed");

    // Steer into the other tree's running turn.
    gw.worker.holdTurns = true;

    const own = (await gw.api.sendMessage({ threadId: target.id, text: "long work", clientRequestId: "cross-steer" }))
      .turn!;

    await eventually(
      () => turns(target.id),
      (t) => t.some((x) => x.id === own.id && x.status === "running"),
    );

    const steer = json(
      await studio.callTool({
        threadId: sender.id,
        tool: "send_message",
        args: { thread_id: target.id, prompt: "Stop and push", delivery: "steer", notify: false },
      }),
    );

    expect([steer["delivery"], steer["turn_id"]]).toEqual(["steer", own.id]);
    expect((await snapshot(target.id)).steers.find((s) => s.text === "Stop and push")?.sender?.title).toBe(
      "Studio agent",
    );
    gw.worker.holdTurns = false;
    gw.worker.finish(target.id, own.id);
    await settled(target.id);
    await settled(sender.id);
  }, 30_000);

  test("hops carry across trees; control and waiting stay with descendants; reads reach any thread of the owner", async () => {
    const a = await mainThread("Tree A", Provider.CODEX);
    const b = await mainThread("Tree B", Provider.CODEX, { projectId: laptopProject, workspaceId: laptopWorkspace });
    // A's turn runs at the end of a long agent chain: a message from another agent, its hops raised to 7.
    await gw.worker.callTool({
      threadId: b.id,
      tool: "send_message",
      args: { thread_id: a.id, prompt: "start", notify: false },
    });

    const aTurn = (
      await eventually(
        () => turns(a.id),
        (t) => t.length === 2 && t[1]?.status === "completed",
      )
    )[1];

    await query("UPDATE turns SET hops = 7 WHERE id = $1::uuid", aTurn!.id);

    const limited = await studio.callTool({
      threadId: a.id,
      turnId: aTurn!.id,
      tool: "send_message",
      args: { thread_id: b.id, prompt: "ping" },
    });

    expect(limited.content).toContain("chain limit");

    const quiet = await studio.callTool({
      threadId: a.id,
      turnId: aTurn!.id,
      tool: "send_message",
      args: { thread_id: b.id, prompt: "ping", notify: false },
    });

    expect(quiet.isError).toBe(false);

    const bTurns = await eventually(
      () => turns(b.id),
      (t) => t.length === 2 && t[1]?.status === "completed",
    );

    expect(bTurns[1]?.hops).toBe(8);

    // B's agent cannot answer back: the chain is at its limit.
    const back = await gw.worker.callTool({
      threadId: b.id,
      turnId: bTurns[1]!.id,
      tool: "send_message",
      args: { thread_id: a.id, prompt: "pong", notify: false },
    });

    expect(back.content).toContain("chain limit");

    // A worker speaks only for its own threads: the studio cannot send as B (on the laptop).
    const spoofed = await studio.callTool({
      threadId: b.id,
      tool: "send_message",
      args: { thread_id: a.id, prompt: "as B", notify: false },
    });

    expect([spoofed.isError, spoofed.content]).toEqual([true, `thread ${b.id} not found`]);

    expect(
      (await studio.callTool({ threadId: a.id, tool: "interrupt_thread", args: { thread_id: b.id } })).content,
    ).toContain("not found");
    expect(
      (await studio.callTool({ threadId: a.id, tool: "close_thread", args: { thread_id: b.id } })).content,
    ).toContain("not found");
    expect(
      (
        await studio.callTool({
          threadId: a.id,
          tool: "wait_threads",
          args: { thread_ids: [b.id], timeout_seconds: 1 },
        })
      ).content,
    ).toContain("not found in your thread tree");
    const status = json(await studio.callTool({ threadId: a.id, tool: "get_thread", args: { thread_id: b.id } }));
    expect(status).toMatchObject({ thread_id: b.id, project: "Elsewhere", worker: "laptop", provider: "codex/native" });

    const read = json(await studio.callTool({ threadId: a.id, tool: "read_thread", args: { thread_id: b.id } })) as {
      entries: unknown[];
    };

    expect(read.entries.length).toBeGreaterThan(0);
  }, 30_000);

  test("another owner's threads are invisible to every tool", async () => {
    const a = await mainThread("Mine", Provider.CODEX);

    const other = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* GatewayStore;
        const userId = yield* store.ensureUser("other@localhost", "Other");
        const project = yield* store.createProject(userId, "Theirs");
        // Their own worker: a thread can only be placed on a worker of its owner.
        const worker = yield* store.addWorker({ ownerUserId: userId, name: "their-worker" });
        yield* store.setWorkerConfig(
          worker.workerId,
          { allowedRoots: ["/repo"], codex: { enabled: true }, claude: { enabled: true } },
          userId,
        );

        const workspace = yield* store.createWorkspace({
          projectId: project.id,
          workerId: worker.workerId,
          rootPath: "/repo/theirs",
          label: "",
        });

        return yield* store.createThread(
          userId,
          create(ui.CreateThreadRequestSchema, {
            projectId: project.id,
            workspaceId: workspace.id,
            title: "Their thread",
            provider: Provider.CODEX,
          }),
        );
      }),
    );

    for (const [tool, args] of [
      ["send_message", { thread_id: other.id, prompt: "hi" }],
      ["get_thread", { thread_id: other.id }],
      ["read_thread", { thread_id: other.id }],
    ] as const) {
      expect((await studio.callTool({ threadId: a.id, tool, args })).content).toBe(`thread ${other.id} not found`);
    }

    const all = json(
      await studio.callTool({ threadId: a.id, tool: "list_threads", args: { scope: "all", limit: 50 } }),
    ) as { threads: { title: string }[] };

    expect(all.threads.map((t) => t.title)).not.toContain("Their thread");
    expect(all.threads.map((t) => t.title)).toContain("Tree B");
  }, 30_000);
});
