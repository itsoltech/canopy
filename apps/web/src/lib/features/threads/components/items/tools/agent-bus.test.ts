import { describe, expect, test } from "bun:test";
import { agentsOf, busError, busLook, deliveryOf, interactionsOf, permissionWords, scheduleOf, schedulesOf, summariesOf, transcriptOf } from "./agent-bus.ts";

const summary = {
  thread_id: "01a19868-b267-75e4-9a45-8a566cb687ce",
  title: "Lister",
  kind: "side",
  parent_thread_id: null,
  status: "idle",
  settled: true,
  queued_turns: 0,
  waiting_for_parent: 1,
  waiting_for_user: 0,
  model: "gpt-5",
  effort: "high",
  permission_mode: "full_auto",
  last_turn: { turn_id: "x", status: "failed", reason: "quota" },
  last_message: " 3 files ",
};

describe("busLook", () => {
  test("titles by tool and state", () => {
    expect(busLook("read_thread", {}, false)).toEqual({ title: "Read", icon: "document-text" });
    expect(busLook("wait_threads", {}, true).title).toBe("Waiting for");
    expect(busLook("list_threads", { scope: "tree" }, false).title).toBe("Listed the thread tree");
    expect(busLook("answer_interaction", { response: "deny" }, false).title).toBe("Denied for a side thread");
    expect(busLook("some_new_tool", {}, false).title).toBe("Some new tool");
  });

  test("errors", () => {
    expect(busError('{"error":"thread not found"}')).toBe("thread not found");
    expect(busError("plain reason")).toBe("plain reason");
  });
});

describe("thread summaries", () => {
  test("get_thread, wait_threads and list_threads", () => {
    const [one] = summariesOf("get_thread", summary);
    expect(one).toEqual({
      threadId: summary.thread_id,
      title: "Lister",
      status: "idle",
      settled: true,
      queuedTurns: 0,
      waitingForParent: 1,
      waitingForUser: 0,
      lastTurn: "Failed: quota",
      lastTurnStatus: "failed",
      lastMessage: "3 files",
      settings: "gpt-5 · high · Full auto",
    });
    expect(summariesOf("wait_threads", { done: true, threads: [summary, summary] })).toHaveLength(2);
    expect(summariesOf("list_threads", { threads: [{ nope: 1 }] })).toEqual([]);
  });

  test("permission words", () => {
    expect(permissionWords("read_only")).toBe("Read only");
    expect(permissionWords("PERMISSION_MODE_ACCEPT_EDITS")).toBe("Accept edits");
    expect(permissionWords("")).toBe("");
  });
});

describe("transcriptOf", () => {
  test("messages, commands and tools; no ids or seqs in the text", () => {
    const lines = transcriptOf({
      entries: [
        { seq: 3, type: "user_message", userMessage: { text: "Hej", clientId: "01a198ce-fe6d-77c3-b110-8d25414fb489", authorUserId: "x" } },
        { seq: 9, type: "agent_message", agentMessage: { text: "Hej! What can I help you with?" } },
        { seq: 10, type: "command_execution", commandExecution: { command: "ls -A" } },
        { seq: 11, type: "tool_call", toolCall: { name: "Read", inputJson: '{"file_path":"/a/b.ts"}' } },
        { seq: 12, type: "file_change", fileChange: { changes: [{ path: "src/x.ts" }] } },
        { seq: 13, type: "agent_bus_call", agentBusCall: { toolName: "spawn_thread", argumentsJson: "{}" } },
        { seq: 14, type: "context_compaction", contextCompaction: {} },
      ],
      nextSeq: 14,
    });
    expect(lines.map((l) => [l.role, l.text])).toEqual([
      ["user", "Hej"],
      ["agent", "Hej! What can I help you with?"],
      ["activity", "ls -A"],
      ["activity", "Read b.ts"],
      ["activity", "Edited x.ts"],
      ["activity", "Started a subagent"],
      ["activity", "Context compaction"],
    ]);
    expect(lines[2]!.mono).toBe(true);
  });
});

describe("schedules", () => {
  test("a wake-up after a delay, with its next run", () => {
    const view = scheduleOf({ delay_seconds: 60, prompt: "Reply with PING" }, { schedule_id: "x", thread_id: "t", next_run_at: "2026-11-01T18:21:00.781Z" });
    expect(view.when).toBe("In 1 minute");
    expect(view.next).not.toBe("");
    expect(view.next).not.toContain("T18");
    expect(view.prompt).toBe("Reply with PING");
  });

  test("recurring in words, with zone and limits", () => {
    const view = scheduleOf({ cron: "0 9 * * 1-5", timezone: "Europe/Warsaw", max_runs: 5, prompt: "x" });
    expect(view.when).toBe("Weekdays at 09:00 (Europe/Warsaw)");
    expect(view.limits).toBe("up to 5 runs");
    expect(scheduleOf({ cron: "*/30 * * * *", timezone: "UTC" }).when).toBe("Every 30 minutes");
  });

  test("list_schedules rows", () => {
    expect(schedulesOf({ schedules: [{ kind: "once", run_at: "2026-11-03T09:00:00Z", status: "active", prompt: "p" }] })[0]).toMatchObject({ status: "active", prompt: "p" });
  });
});

describe("other results", () => {
  test("send_message delivery", () => {
    expect(deliveryOf({}, {})).toBe("Runs as the next turn");
    expect(deliveryOf({ delivery: "steer" }, { delivery: "steer" })).toBe("Joins the turn that is running now");
    expect(deliveryOf({ delivery: "steer" }, { delivery: "queue" })).toBe("Nothing was running there, so it runs as the next turn");
  });

  test("interactions and agents", () => {
    expect(interactionsOf({ interactions: [{ request_id: "r", thread_id: "t", kind: "permission", tool_name: "Bash", request: { command: "rm" } }] })).toEqual([
      { threadId: "t", kind: "Permission", tool: "Bash", request: { command: "rm" } },
    ]);
    expect(agentsOf({ agents: [{ slug: "code_reviewer", description: "Reviews", provider: "claude", model: "opus" }] })).toEqual([
      { name: "Code reviewer", description: "Reviews", settings: "Claude · opus" },
    ]);
    expect(agentsOf({ agents: [], note: "x" })).toEqual([]);
  });
});
