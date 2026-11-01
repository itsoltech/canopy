import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { ServerNotification } from "@open-agents/codex-protocol";
import {
  ItemStatus,
  NoticeLevel,
  ThreadEventSchema,
  ThreadStatus,
  TurnOrigin,
  TurnOutcome,
  type Item,
  type ThreadEvent,
} from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain";
import { CodexEventMapper, mapItem } from "./mapping.ts";

/** Recorded live streams (Codex 0.164.0), scrubbed of local paths and moderation metadata. */
function fixture(name: string): ServerNotification[] {
  return readFileSync(join(import.meta.dir, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServerNotification);
}

function replay(notifications: ServerNotification[], commandTurns: ReadonlySet<string> = new Set()) {
  const turnIds = new Map<string, string>();
  const mapper = new CodexEventMapper({
    turnId: (codexTurnId) => turnIds.get(codexTurnId) ?? turnIds.set(codexTurnId, `turn-${turnIds.size + 1}`).get(codexTurnId)!,
    isCommandTurn: (codexTurnId) => commandTurns.has(codexTurnId),
  });
  const events: ThreadEvent[] = [];
  for (const n of notifications) {
    for (const init of mapper.map(n)) events.push(create(ThreadEventSchema, { threadId: "t", ...init } as never));
  }
  // Same projection the gateway and the UI run.
  const items = new Map<string, Item>();
  for (const e of events) {
    const id = eventItemId(e.body);
    if (!id) continue;
    const next = reduceItem(items.get(id), e.body);
    if (next) items.set(id, next);
  }
  return { events, items: [...items.values()] };
}

describe("Codex event mapping on a recorded turn with tools", () => {
  const notifications = fixture("tools-turn");
  const codexTurnId = (notifications.find((n) => n.method === "turn/started")!.params as { turn: { id: string } }).turn.id;
  const { events, items } = replay(notifications, new Set([codexTurnId]));

  test("nothing is lost: every notification yields an event with the raw original", () => {
    expect(events).toHaveLength(notifications.length);
    expect(events.every((e) => e.rawJson.length > 0)).toBe(true);
    // Unmapped notifications (moderation metadata, read state) are kept without a body.
    const unmapped = events.filter((e) => e.body.case === undefined).map((e) => JSON.parse(e.rawJson).method);
    expect(new Set(unmapped)).toEqual(new Set(["turn/moderationMetadata", "thread/readState/changed"]));
  });

  test("turn lifecycle: started by the platform, finished with outcome and usage", () => {
    const started = events.find((e) => e.body.case === "turnStarted");
    expect(started?.turnId).toBe("turn-1");
    expect(started?.body.case === "turnStarted" && started.body.value).toMatchObject({ providerTurnRef: codexTurnId, origin: TurnOrigin.COMMAND });
    const finished = events.find((e) => e.body.case === "turnFinished");
    expect(finished?.body.case === "turnFinished" && finished.body.value.outcome).toBe(TurnOutcome.COMPLETED);
    expect(finished?.body.case === "turnFinished" && finished.body.value.usage?.inputTokens).toBe(24055n);
  });

  test("thread activity: running, then idle", () => {
    const statuses = events.flatMap((e) => (e.body.case === "activity" ? [e.body.value.status] : []));
    expect(statuses).toEqual([ThreadStatus.RUNNING, ThreadStatus.IDLE]);
  });

  test("projected items: user message, commentary, two commands with output, final answer", () => {
    const summary = items.map((item) => {
      switch (item.content.case) {
        case "userMessage":
          return ["user", item.content.value.text.slice(0, 20)];
        case "agentMessage":
          return ["agent", item.content.value.phase, item.content.value.text];
        case "commandExecution":
          return ["command", item.content.value.command, item.content.value.exitCode, item.content.value.output];
        default:
          return [item.content.case];
      }
    });
    expect(summary).toEqual([
      ["user", "Create a file named "],
      ["agent", "commentary", "I’ll create `hello.txt` with exactly `hi`, then run `cat hello.txt`."],
      ["command", "/usr/bin/bash -lc 'printf hi > hello.txt'", 0, ""],
      ["command", "/usr/bin/bash -lc 'cat hello.txt'", 0, "hi"],
      ["agent", "final_answer", "DONE"],
    ]);
    expect(items.every((item) => item.status === ItemStatus.COMPLETED)).toBe(true);
  });

  test("streamed deltas assemble the same text as the completed item", () => {
    const commentary = notifications.filter((n) => n.method === "item/agentMessage/delta").slice(0, -1);
    const text = commentary.map((n) => (n.params as { delta: string }).delta).join("");
    expect(text).toBe("I’ll create `hello.txt` with exactly `hi`, then run `cat hello.txt`.");
  });
});

describe("Codex event mapping on a recorded failing turn", () => {
  const { events } = replay(fixture("error-turn"));

  test("provider-started turn (not from StartTurn), failure reason, error notice, failed activity", () => {
    const started = events.find((e) => e.body.case === "turnStarted");
    expect(started?.body.case === "turnStarted" && started.body.value.origin).toBe(TurnOrigin.PROVIDER);
    const finished = events.find((e) => e.body.case === "turnFinished");
    expect(finished?.body.case === "turnFinished" && finished.body.value).toMatchObject({
      outcome: TurnOutcome.FAILED,
      reason: "Missing environment variable: `CLIPROXY_API_KEY`.",
    });
    const notice = events.find((e) => e.body.case === "notice");
    expect(notice?.body.case === "notice" && notice.body.value).toMatchObject({ level: NoticeLevel.ERROR, code: "other" });
    expect(events.flatMap((e) => (e.body.case === "activity" ? [e.body.value.status] : []))).toEqual([
      ThreadStatus.RUNNING,
      ThreadStatus.FAILED,
    ]);
    // Hooks from the device's ~/.codex appear raw (this recording ran without CODEX_HOME isolation).
    expect(events.some((e) => e.body.case === undefined && JSON.parse(e.rawJson).method === "hook/started")).toBe(true);
  });
});

describe("mapItem", () => {
  test("file changes, MCP and agent bus calls, unknown types", () => {
    expect(
      mapItem(
        {
          type: "fileChange",
          id: "f1",
          status: "completed",
          changes: [
            { path: "a.ts", kind: { type: "add" }, diff: "+x" },
            { path: "b.ts", kind: { type: "update", move_path: "c.ts" }, diff: "" },
          ],
        },
        true,
      ),
    ).toMatchObject({
      status: ItemStatus.COMPLETED,
      content: { case: "fileChange", value: { changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "move", movePath: "c.ts" }] } },
    });

    const bus = mapItem(
      {
        type: "dynamicToolCall",
        id: "call-1",
        namespace: null,
        tool: "spawn_thread",
        arguments: { title: "Review", prompt: "Review" },
        status: "completed",
        contentItems: [{ type: "inputText", text: '{"thread_id":"x"}' }],
        success: true,
        durationMs: 12,
      },
      true,
    );
    expect(bus.content?.case).toBe("agentBusCall");

    const declined = mapItem(
      {
        type: "commandExecution",
        id: "c1",
        pluginId: null,
        scriptPath: null,
        command: "rm -rf /",
        cwd: "/work/repo",
        processId: null,
        source: "agent",
        status: "declined",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
      true,
    );
    expect(declined.status).toBe(ItemStatus.DECLINED);

    const unknown = mapItem({ type: "sleep", id: "s1", durationMs: 1000 }, true);
    expect(unknown.content).toMatchObject({ case: "providerItem", value: { type: "sleep" } });
  });
});
