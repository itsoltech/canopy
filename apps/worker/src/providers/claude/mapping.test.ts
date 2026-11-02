import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTaskKind, ItemStatus, ThreadEventSchema, TurnOutcome, type Item, type ThreadEvent } from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain";
import { ClaudeEventMapper, startsTurn, toolContent } from "./mapping.ts";
import { goalVerdictOf } from "./threads.ts";

/** Recorded live streams (Claude Agent SDK 0.3.316, Claude Code 2.1.316, claude-haiku-5-5 via CLIProxyAPI). */
function fixture(name: string): SDKMessage[] {
  return readFileSync(join(import.meta.dir, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SDKMessage);
}

function replay(messages: SDKMessage[]) {
  const mapper = new ClaudeEventMapper("turn-1");
  const events: ThreadEvent[] = [];
  for (const m of messages) for (const init of mapper.map(m)) events.push(create(ThreadEventSchema, { threadId: "t", ...init } as never));
  // Same projection the gateway and the UI run.
  const items = new Map<string, Item>();
  for (const e of events) {
    const id = eventItemId(e.body);
    if (!id) continue;
    const next = reduceItem(items.get(id), e.body);
    if (next) items.set(id, next);
  }
  return { events, items: [...items.values()], mapper };
}

const summary = (items: Item[]) =>
  items.map((i) => {
    const c = i.content;
    switch (c.case) {
      case "agentMessage":
        return ["agentMessage", c.value.text];
      case "commandExecution":
        return ["commandExecution", c.value.command, c.value.output];
      case "fileChange":
        return ["fileChange", c.value.changes.map((x) => `${x.kind} ${x.path.split("/").pop()}`).join(",")];
      case "toolCall":
        return ["toolCall", `${c.value.server}/${c.value.name}`, c.value.isError];
      default:
        return [c.case ?? "none"];
    }
  });

describe("Claude event mapping on recorded turns", () => {
  test("a resumed session's zero-turn task-notification result does not finish the pending input", () => {
    const { events } = replay(fixture("background-resume-ack"));
    const finishes = events.filter((e) => e.body.case === "turnFinished");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.turnId).toBe("turn-1");
    expect(events.find((e) => e.body.case === "itemCompleted")?.turnId).toBe("turn-1");
  });

  test("a late task-notification acknowledgement by itself does not start a provider turn", () => {
    const { events, turns } = replaySession([
      ...fixture("text-turn"),
      fixture("background-resume-ack")[2]!,
    ]);
    expect(events.filter((e) => e.body.case === "turnFinished")).toHaveLength(1);
    expect(turns).toBe(1);
  });

  test("zero-turn commands, notification errors and real notification answers still finish their turns", () => {
    const ack = fixture("background-resume-ack")[2]!;
    for (const patch of [{ origin: undefined }, { is_error: true }, { num_turns: 1 }]) {
      const mapper = new ClaudeEventMapper("pending");
      const message = { ...ack, ...patch } as SDKMessage;
      expect(startsTurn(message)).toBe(true);
      expect(mapper.map(message)[0]).toMatchObject({ turnId: "pending", body: { case: "turnFinished" } });
    }
  });

  test("text turn: streamed message, completed once, usage and outcome on turn_finished", () => {
    const messages = fixture("text-turn");
    const { events, items, mapper } = replay(messages);
    expect(summary(items)).toEqual([["agentMessage", "OK"]]);
    expect(events.filter((e) => e.body.case === "itemDelta").map((e) => (e.body.value as { chunk: string }).chunk)).toEqual(["OK"]);
    const finished = events.find((e) => e.body.case === "turnFinished")!.body.value as { outcome: TurnOutcome; providerTurnRef: string; usage: { outputTokens: bigint } };
    expect(finished.outcome).toBe(TurnOutcome.COMPLETED);
    expect(finished.usage.outputTokens).toBe(4n);
    expect(finished.providerTurnRef).toBe(mapper.lastEntry!);
    expect(events.every((e) => e.rawJson.length > 0 && e.turnId === "turn-1")).toBe(true);
  });

  test("tools turn: file write, tool search, shell command with output, MCP tool, final message", () => {
    const { items, events } = replay(fixture("tools-turn"));
    expect(summary(items)).toEqual([
      ["fileChange", "add hello.txt"],
      ["toolCall", "/ToolSearch", false],
      ["commandExecution", "cat hello.txt", "hi"],
      ["toolCall", "openagents/record_token", false],
      ["agentMessage", "DONE"],
    ]);
    expect(items.every((i) => i.status === ItemStatus.COMPLETED)).toBe(true);
    // Redacted thinking (empty text, signature only) does not become an empty item.
    expect(items.some((i) => i.content.case === "reasoning")).toBe(false);
    // Partial tool input and signatures are not journaled; message-level events are.
    const raw = events.map((e) => JSON.parse(e.rawJson) as { type: string; event?: { delta?: { type?: string } } });
    expect(raw.some((m) => m.type === "stream_event" && m.event?.delta?.type === "input_json_delta")).toBe(false);
    expect(raw.filter((m) => m.type === "assistant").length).toBe(fixture("tools-turn").filter((m) => m.type === "assistant").length);
  });

  test("agent bus tools become agent_bus_call items; failed tools are failed items", () => {
    expect(toolContent("mcp__openagents__spawn_thread", { title: "x", prompt: "y" })).toEqual({
      case: "agentBusCall",
      value: { toolName: "spawn_thread", argumentsJson: '{"title":"x","prompt":"y"}' },
    });
    expect(toolContent("mcp__github__create_issue", { a: 1 })).toEqual({ case: "toolCall", value: { server: "github", name: "create_issue", inputJson: '{"a":1}' } });
    const mapper = new ClaudeEventMapper("t");
    mapper.map({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "tu", name: "Bash", input: { command: "false" } }] }, parent_tool_use_id: null, uuid: "u1", session_id: "s" } as never);
    const [done] = mapper.map({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu", content: "exit 1", is_error: true }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s" } as never);
    expect(done?.body).toMatchObject({ case: "itemCompleted", value: { item: { itemId: "tu", status: ItemStatus.FAILED, content: { case: "commandExecution", value: { command: "false", output: "exit 1" } } } } });
    expect(mapper.lastEntry).toBe("u2");
  });

  test("an interrupted turn is interrupted, not failed", () => {
    const mapper = new ClaudeEventMapper("t");
    mapper.markInterrupted();
    const [finished] = mapper.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["aborted"], usage: {}, total_cost_usd: 0 } as never);
    expect(finished?.body).toMatchObject({ case: "turnFinished", value: { outcome: TurnOutcome.INTERRUPTED } });
  });
});

/** Like the runtime: the first turn is the platform's, a turn starting between turns is Claude's own. */
function replaySession(messages: SDKMessage[], before?: (mapper: ClaudeEventMapper, m: SDKMessage) => void) {
  const mapper = new ClaudeEventMapper("turn-1");
  const events: ThreadEvent[] = [];
  let turns = 1;
  for (const m of messages) {
    before?.(mapper, m);
    if (!mapper.turnId && startsTurn(m)) mapper.beginTurn(`turn-${++turns}`);
    for (const init of mapper.map(m)) events.push(create(ThreadEventSchema, { threadId: "t", ...init } as never));
  }
  const items = new Map<string, Item>();
  for (const e of events) {
    const id = eventItemId(e.body);
    if (!id) continue;
    const next = reduceItem(items.get(id), e.body);
    if (next) items.set(id, next);
  }
  return { events, items: [...items.values()], mapper, turns };
}

const task = (item: Item | undefined) => (item?.content.case === "backgroundTask" ? item.content.value : undefined);

describe("Claude background Bash (recorded, open input)", () => {
  test("background item outside the turn; its end makes Claude start a turn of its own", () => {
    const { events, items, mapper, turns } = replaySession(fixture("background-bash-turn"));
    const bg = items.find((i) => i.content.case === "backgroundTask");
    expect(bg?.itemId).toBe("bg:b9mgczlyo");
    expect(task(bg)).toMatchObject({
      taskId: "b9mgczlyo",
      kind: BackgroundTaskKind.SHELL,
      command: "for i in $(seq 1 12); do echo tick $i; sleep 1; done",
      startedInTurnId: "turn-1",
      sourceItemId: "toolu_01DXHGMmxC7dRkR9emmmhyMT",
    });
    expect(bg?.status).toBe(ItemStatus.COMPLETED);
    expect(task(bg)?.progress?.summary).toContain("completed");
    // Two turns: the platform's, then Claude's report of the finished task.
    expect(turns).toBe(2);
    expect(events.filter((e) => e.body.case === "turnFinished").map((e) => e.turnId)).toEqual(["turn-1", "turn-2"]);
    const end = events.find((e) => e.body.case === "itemCompleted" && e.body.value.item?.itemId === "bg:b9mgczlyo");
    expect(end?.turnId).toBe(""); // between turns
    expect(mapper.backgroundTasks).toEqual([]);
  });

  test("output read from the task's file lands on its item; a requested stop ends it as stopped by the user", () => {
    const messages = fixture("background-bash-stopped");
    const { items } = replaySession(messages, (mapper, m) => {
      if (m.type === "system" && m.subtype === "task_notification") {
        expect(mapper.outputFile("bmzcmnrxf")).toMatch(/tasks\/bmzcmnrxf\.output$/);
        mapper.markStopping("bmzcmnrxf");
        expect(mapper.taskOutput("bmzcmnrxf", "tick 1\ntick 2\n")).toHaveLength(1);
      }
    });
    // taskOutput events are emitted by the runtime; here only the item state is checked.
    const bg = items.find((i) => i.content.case === "backgroundTask");
    expect(bg?.status).toBe(ItemStatus.INTERRUPTED);
    expect(task(bg)?.stopReason).toBe("stopped_by_user");
  });

  test("tasks still open when the process ends are interrupted", () => {
    const messages = fixture("background-bash-stopped").filter((m) => !(m.type === "system" && m.subtype === "task_notification"));
    const { mapper } = replaySession(messages);
    const [ended] = mapper.endTasks("worker_restart");
    expect(ended?.body).toMatchObject({ case: "itemCompleted", value: { item: { status: ItemStatus.INTERRUPTED, content: { value: { stopReason: "worker_restart" } } } } });
  });
});

describe("Claude /goal (recorded)", () => {
  test("the local answer of /goal sets the goal; the evaluator's verdict from the transcript completes it", () => {
    const { events, mapper } = replaySession(fixture("goal-turn"));
    const states = events.flatMap((e) => (e.body.case === "goalState" ? [e.body.value] : []));
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ nativeStatus: "active", objective: "A file named goal.txt exists in the current directory and contains exactly the word done" });
    const verdicts = readFileSync(join(import.meta.dir, "fixtures", "goal-transcript.jsonl"), "utf8").split("\n").map(goalVerdictOf).filter((v) => v !== undefined);
    expect(verdicts.map((v) => [v.met, v.sentinel ?? false])).toEqual([[false, true], [true, false]]);
    mapper.beginTurn("turn-x");
    const goal = verdicts.flatMap((v) => mapper.goalVerdict(v)).map((e) => e.body?.value);
    expect(goal).toMatchObject([{ nativeStatus: "met", iterations: 1, lastReason: expect.stringContaining("goal.txt") }]);
  });

  test("Goal cleared and not-met verdicts", () => {
    const mapper = new ClaudeEventMapper("t");
    const [, cleared] = mapper.map({ type: "assistant", message: { id: "s", model: "<synthetic>", content: [{ type: "text", text: "Goal cleared: tests pass" }] }, parent_tool_use_id: null, uuid: "u", session_id: "s" } as never);
    expect(cleared?.body).toMatchObject({ case: "goalState", value: { nativeStatus: "cleared", cleared: true, objective: "tests pass" } });
    expect(mapper.goalVerdict({ met: false, condition: "tests pass", reason: "2 fail" })[0]?.body).toMatchObject({ value: { nativeStatus: "active", iterations: 1, lastReason: "2 fail" } });
    expect(mapper.goalVerdict({ met: false, failed: true, condition: "tests pass" })[0]?.body).toMatchObject({ value: { nativeStatus: "failed" } });
  });
});
