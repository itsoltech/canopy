import { describe, expect, test } from "bun:test";
import {
  budgetExceeded,
  canTransition,
  claudeGoalInput,
  codexObjective,
  fromClaudeActiveGoal,
  fromCodexStatus,
  toCodexGoal,
  validateGoalBudget,
  type CodexGoalStatus,
  type GoalStatus,
} from "./goals.ts";

describe("goal transitions", () => {
  test("the model may only claim the outcome", () => {
    expect(canTransition("active", "achieved", "agent")).toBe(true);
    expect(canTransition("active", "blocked", "agent")).toBe(true);
    expect(canTransition("active", "paused", "agent")).toBe(false);
    expect(canTransition("blocked", "active", "agent")).toBe(false);
    expect(canTransition("proposed", "active", "agent")).toBe(false); // agents cannot approve their own goals
  });

  test("the user approves, pauses, resumes, cancels and reopens", () => {
    for (const [from, to] of [
      ["proposed", "active"],
      ["active", "paused"],
      ["paused", "active"],
      ["blocked", "active"],
      ["budget_limited", "active"],
      ["achieved", "active"],
      ["active", "cancelled"],
    ] as const) {
      expect(canTransition(from, to, "user")).toBe(true);
    }
    expect(canTransition("cancelled", "active", "user")).toBe(false);
  });

  test("the system enforces limits but never resumes a paused goal", () => {
    expect(canTransition("active", "budget_limited", "system")).toBe(true);
    expect(canTransition("paused", "active", "system")).toBe(false);
    expect(canTransition("budget_limited", "active", "system")).toBe(false);
  });
});

describe("budgets", () => {
  const usage = { tokens: 1000, costUsd: 0.5, seconds: 60, turns: 3 };

  test("first exceeded budget wins; open-ended goals never exceed", () => {
    expect(budgetExceeded({}, usage)).toBeUndefined();
    expect(budgetExceeded({ tokens: 5000, turns: 3 }, usage)).toBe("continuation limit (3) reached");
    expect(budgetExceeded({ costUsd: 0.5 }, usage)).toBe("cost budget ($0.5) used");
  });

  test("agents must bound their goals; users may not", () => {
    expect(validateGoalBudget({}, "agent")).toContain("at least one budget");
    expect(validateGoalBudget({}, "user")).toBeUndefined();
    expect(validateGoalBudget({ tokens: -1 }, "user")).toContain("positive");
    expect(validateGoalBudget({ seconds: 3600 }, "agent")).toBeUndefined();
  });
});

describe("native engines", () => {
  const goal = { objective: "Migrate auth to Effect", condition: "bun test exits 0 and no Promise-based auth code remains" };

  test("Codex: objective carries the completion condition; statuses map both ways", () => {
    expect(codexObjective(goal)).toBe("Migrate auth to Effect\n\nDone when: bun test exits 0 and no Promise-based auth code remains");
    const native: CodexGoalStatus[] = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"];
    expect(native.map(fromCodexStatus)).toEqual(["active", "paused", "blocked", "usage_limited", "budget_limited", "achieved"]);
    const platform: GoalStatus[] = ["active", "paused", "blocked", "budget_limited", "achieved", "cancelled", "proposed"];
    expect(platform.map(toCodexGoal)).toEqual([
      { set: "active" },
      { set: "paused" },
      { set: "paused" },
      { set: "paused" },
      { set: "complete" },
      { clear: true },
      { set: "paused" },
    ]);
  });

  test("Claude: slash commands in, active_goal out; null means met unless we asked to clear", () => {
    expect(claudeGoalInput(goal, "active")).toBe(`/goal ${goal.condition}`);
    expect(claudeGoalInput(goal, "paused")).toBe("/goal clear");
    expect(fromClaudeActiveGoal(null, false)).toEqual({ status: "achieved" });
    expect(fromClaudeActiveGoal(null, true)).toEqual({ status: "unchanged" });
    expect(fromClaudeActiveGoal({ condition: "x", iterations: 4, last_reason: "2 tests still fail" }, false)).toEqual({
      status: "active",
      iterations: 4,
      reason: "2 tests still fail",
    });
  });
});
