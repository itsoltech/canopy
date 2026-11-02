import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, Provider, UserMessageSchema, ui } from "@open-agents/contracts";
import { FeedBuilder, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-state.svelte.ts";
import { buildTimeline, isSteerMessage, topLevelEntry } from "../src/lib/features/threads/timeline.ts";
import { goalActions, goalPending, iterationsLabel, showsGoal, formatElapsed, takesGoals, takesTokenBudget, budgetShare } from "../src/lib/features/goals/goals.ts";

let seq = 0n;
const message = (id: string, turnId: string, clientId: string, text = id): TimelineEntry => ({
  id,
  item: create(ItemSchema, { itemId: id, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: create(UserMessageSchema, { text, clientId }) } }),
  turnId,
  firstSeq: ++seq,
  inherited: false,
  fromThreadId: "",
});
const turn = (id: string, ordinal: number, status: string, inputText = "") => create(ui.TurnSchema, { id, ordinal, status, inputText, trigger: "user" });
const steer = (id: string, status: string, extra: Partial<ui.Steer> = {}) => create(ui.SteerSchema, { id, threadId: "t", turnId: "turn-1", text: `steer ${id}`, status, ...extra });

describe("steered messages in the timeline", () => {
  test("a user_message with a steer's client_id is a steer, the turn's own input is not", () => {
    expect(isSteerMessage(message("m1", "turn-1", "turn-1"))).toBe(false);
    expect(isSteerMessage(message("m2", "turn-1", ""))).toBe(false);
    expect(isSteerMessage(message("m3", "turn-1", "steer-1"))).toBe(true);
  });

  test("the steer stays an item inside the turn and does not replace the turn's input", () => {
    const rows = buildTimeline([message("s1", "turn-1", "steer-1", "change of plan")], [turn("turn-1", 1, "running", "do the thing")], [], new Map());
    expect(rows.map((r) => r.kind)).toEqual(["turn-start", "input", "item"]);
    const item = rows[2]!;
    expect(item.kind === "item" && item.steer && item.inputOf === undefined).toBe(true);
  });

  test("the echoed input is the turn's input, a later steer is marked", () => {
    const rows = buildTimeline([message("in", "turn-1", "turn-1"), message("s1", "turn-1", "steer-1")], [turn("turn-1", 1, "completed", "do it")], [], new Map());
    const items = rows.filter((r) => r.kind === "item");
    expect(items.map((r) => r.kind === "item" && [r.inputOf?.id, r.steer])).toEqual([["turn-1", false], [undefined, true]]);
  });
});

describe("topLevelEntry", () => {
  test("a nested item resolves to the item with its own row", () => {
    const parent = message("agent", "turn-1", "");
    const child: TimelineEntry = { ...message("bg", "turn-1", ""), item: create(ItemSchema, { itemId: "bg", parentItemId: "agent" }) };
    expect(topLevelEntry([parent, child], child).id).toBe("agent");
    expect(topLevelEntry([parent, child], parent).id).toBe("agent");
  });
});

describe("feed rows for steers", () => {
  const input = (over: Partial<FeedInput>): FeedInput => ({
    entries: [],
    turns: [turn("turn-1", 1, "running", "go")],
    notices: [],
    results: new Map(),
    steering: [],
    working: true,
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set(),
    ...over,
  });

  test("steers on their way follow the working indicator; queued turns are not rows (the queue panel has them)", () => {
    const queued = turn("turn-2", 2, "queued", "later");
    const rows = new FeedBuilder().build(input({ steering: [steer("a", "pending")], turns: [turn("turn-1", 1, "running", "go"), queued] }));
    expect(rows.slice(-2).map((r) => r.kind)).toEqual(["working", "steer"]);
    expect(rows.some((r) => r.key.includes("turn-2"))).toBe(false);
  });

  test("turns taken out of the queue are not shown, and the turn numbers skip them", () => {
    const deleted = create(ui.TurnSchema, { id: "turn-2", ordinal: 2, status: "cancelled", withdrawn: "deleted", inputText: "gone", trigger: "user" });
    const rows = buildTimeline([], [turn("turn-1", 1, "completed", "one"), deleted, turn("turn-3", 3, "completed", "three")], [], new Map());
    expect(rows.flatMap((r) => (r.kind === "turn-start" ? [[r.turn.id, r.number]] : []))).toEqual([
      ["turn-1", 1],
      ["turn-3", 2],
    ]);
  });

  test("unchanged steer rows keep their identity between builds", () => {
    const builder = new FeedBuilder();
    const pending = steer("a", "pending");
    const first = builder.build(input({ steering: [pending] }));
    const second = builder.build(input({ steering: [pending] }));
    expect(second.at(-1)).toBe(first.at(-1)!);
  });
});

describe("goals", () => {
  const goal = (status: string, extra: Partial<ui.Goal> = {}) => create(ui.GoalSchema, { id: "g", threadId: "t", objective: "ship it", status, ...extra });

  test("actions follow the gateway's rules", () => {
    expect(goalActions("active")).toEqual({ pause: true, resume: false, clear: true });
    expect(goalActions("paused")).toEqual({ pause: false, resume: true, clear: true });
    expect(goalActions("budget_limited")).toEqual({ pause: false, resume: true, clear: true });
    expect(goalActions("achieved")).toEqual({ pause: false, resume: false, clear: false });
  });

  test("the bar shows open goals, achieved ones until dismissed, never cleared ones", () => {
    expect(showsGoal(undefined, new Set())).toBe(false);
    expect(showsGoal(goal("blocked"), new Set())).toBe(true);
    expect(showsGoal(goal("achieved"), new Set())).toBe(true);
    expect(showsGoal(goal("achieved"), new Set(["g"]))).toBe(false);
    expect(showsGoal(goal("active"), new Set(["g"]))).toBe(true);
    expect(showsGoal(goal("cancelled"), new Set())).toBe(false);
  });

  test("waits for the harness to confirm a decision", () => {
    expect(goalPending(goal("active"))).toBe("Starting…");
    expect(goalPending(goal("active", { nativeStatus: "active" }))).toBeUndefined();
    expect(goalPending(goal("paused", { nativeStatus: "active" }))).toBe("Pausing…");
    expect(goalPending(goal("paused", { nativeStatus: "cleared" }))).toBeUndefined();
    expect(goalPending(goal("active", { nativeStatus: "paused" }))).toBe("Resuming…");
    // The command failed on the worker: nothing is on its way.
    expect(goalPending(goal("blocked", { error: "THREAD_ERROR: thread/resume failed" }))).toBeUndefined();
    expect(goalPending(goal("active", { error: "THREAD_ERROR: x" }))).toBeUndefined();
  });

  test("gateway threads have no goals", () => {
    expect(takesGoals(create(ui.ThreadSchema, { runtime: "gateway" }))).toBe(false);
    expect(takesGoals(create(ui.ThreadSchema, { runtime: "worker" }))).toBe(true);
    expect(takesGoals(create(ui.ThreadSchema, {}))).toBe(true);
  });

  test("usage labels and the Codex-only budget", () => {
    expect(iterationsLabel(1, Provider.CODEX)).toBe("1 turn");
    expect(iterationsLabel(3, Provider.CLAUDE)).toBe("3 checks");
    expect(takesTokenBudget(Provider.CODEX)).toBe(true);
    expect(takesTokenBudget(Provider.CLAUDE)).toBe(false);
    expect(budgetShare(goal("active", { tokenBudget: 1000n, tokensUsed: 250n }))).toBe(0.25);
    expect(budgetShare(goal("active"))).toBeUndefined();
    expect([45, 754, 3900, 7200].map(formatElapsed)).toEqual(["45s", "12m", "1h 5m", "2h"]);
  });
});
