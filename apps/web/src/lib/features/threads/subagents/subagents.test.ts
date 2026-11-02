import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { subagentState, subagentsOf, subagentSummary } from "./subagents.ts";

const thread = (id: string, extra: Partial<Pick<ui.Thread, "status" | "lastTurnStatus" | "pendingInteractions" | "parentThreadId" | "spawnedByAgent">> & { created?: number } = {}) =>
  create(ui.ThreadSchema, { id, status: "idle", parentThreadId: "p", spawnedByAgent: true, createdAt: { seconds: BigInt(extra.created ?? 0) }, ...extra });

describe("subagent state", () => {
  test("a pending question wins, then a running turn, then how the last turn ended", () => {
    expect(subagentState(thread("a", { status: "running", pendingInteractions: 1 }))).toBe("waiting");
    expect(subagentState(thread("a", { status: "waiting_input" }))).toBe("waiting");
    expect(subagentState(thread("a", { status: "running", lastTurnStatus: "completed" }))).toBe("working");
    expect(subagentState(thread("a", { status: "creating" }))).toBe("working");
    expect(subagentState(thread("a", { lastTurnStatus: "completed" }))).toBe("completed");
    expect(subagentState(thread("a", { lastTurnStatus: "failed" }))).toBe("failed");
    expect(subagentState(thread("a", { status: "interrupted" }))).toBe("interrupted");
    expect(subagentState(thread("a", { status: "failed" }))).toBe("failed");
    expect(subagentState(thread("a", { status: "archived", lastTurnStatus: "completed" }))).toBe("completed");
  });
});

describe("the panel's list and summary", () => {
  const threads = [
    thread("done", { lastTurnStatus: "completed", created: 3 }),
    thread("busy", { status: "running", created: 1 }),
    thread("asks", { status: "running", pendingInteractions: 1, created: 2 }),
    thread("mine", { spawnedByAgent: false }), // a side thread the user opened
    thread("other", { parentThreadId: "q", status: "running" }),
  ];

  test("only the agent's subagents of this thread, the ones at work first, newest first", () => {
    expect(subagentsOf(threads, "p").map((s) => s.thread.id)).toEqual(["asks", "busy", "done"]);
  });

  test("one line with the counts that are there", () => {
    expect(subagentSummary(subagentsOf(threads, "p"))).toBe("3 subagents · 1 running · 1 waiting · 1 done");
    expect(subagentSummary(subagentsOf([thread("x", { lastTurnStatus: "failed" })], "p"))).toBe("1 subagent · 1 failed");
  });
});
