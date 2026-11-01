import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemStatus, ThreadEventSchema, TurnOutcome, type Item, type ThreadEvent } from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain";
import { ClaudeEventMapper, toolContent } from "./mapping.ts";

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
