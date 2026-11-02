import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { isActiveSubagent, subagentState, subagentsOf, subagentSummary } from "./subagents.ts";

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

  test("only active agents started by this thread, newest first", () => {
    expect(subagentsOf(threads, "p").map((s) => s.thread.id)).toEqual(["asks", "busy"]);
  });

  test("one line with the counts that are there", () => {
    expect(subagentSummary(subagentsOf(threads, "p"))).toBe("1 subagent working · 1 needs you");
    expect(subagentSummary(subagentsOf([thread("x", { lastTurnStatus: "failed" })], "p"))).toBe("");
    expect(subagentSummary(subagentsOf([thread("a", { status: "running" }), thread("b", { status: "running" }), thread("q", { status: "waiting_input" })], "p"))).toBe("2 subagents working · 1 needs you");
    expect(subagentSummary(subagentsOf([thread("q", { pendingInteractions: 1 })], "p"))).toBe("1 subagent needs you");
    expect(subagentSummary(subagentsOf([thread("q", { status: "waiting_input" }), thread("r", { pendingInteractions: 2 })], "p"))).toBe("2 subagents need you");
  });

  test("terminal/closed and idle agents are absent, even with stale interactions", () => {
    const inactive = [
      thread("done", { lastTurnStatus: "completed" }), thread("failed", { lastTurnStatus: "failed" }),
      thread("stopped", { lastTurnStatus: "interrupted" }), thread("idle"),
      ...["archived", "closed", "failed", "interrupted"].map((status) => thread(status, { status, pendingInteractions: 1 })),
    ];
    expect(inactive.every((t) => !isActiveSubagent(t))).toBe(true);
    expect(subagentsOf(inactive, "p")).toEqual([]);
    // A mixed caller cannot accidentally count an ended agent in the summary either.
    expect(subagentSummary(inactive.map((t) => ({ thread: t, state: subagentState(t) })))).toBe("");
  });

  test("a new run or a pending answer re-enters; finishing removes the last strip", () => {
    expect(subagentsOf([thread("x", { status: "running", lastTurnStatus: "completed" })], "p")).toHaveLength(1);
    expect(subagentsOf([thread("x", { lastTurnStatus: "completed", pendingInteractions: 1 })], "p")[0]?.state).toBe("waiting");
    expect(subagentsOf([thread("x", { status: "creating" })], "p")).toHaveLength(1);
    expect(subagentsOf([thread("x", { lastTurnStatus: "completed" })], "p")).toEqual([]);
  });
});
