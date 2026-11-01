import { describe, expect, test } from "bun:test";
import {
  budgetExceeded,
  canTransition,
  claudeGoalCommand,
  fromCodexStatus,
  goalStatusFromHarness,
  validateGoalBudget,
  type CodexGoalStatus,
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

describe("harness goals", () => {
  test("Codex statuses map to platform statuses; a user pause is not undone by progress reports", () => {
    const native: CodexGoalStatus[] = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"];
    expect(native.map(fromCodexStatus)).toEqual(["active", "paused", "blocked", "usage_limited", "budget_limited", "achieved"]);
    expect(goalStatusFromHarness("codex", "complete", false, "active")).toBe("achieved");
    expect(goalStatusFromHarness("codex", "active", false, "paused")).toBe("paused");
    expect(goalStatusFromHarness("codex", "active", false, undefined)).toBe("active");
    expect(goalStatusFromHarness("codex", "", true, "active")).toBe("cancelled");
  });

  test("Claude: met and failed verdicts finish the goal; a clear keeps a user pause", () => {
    expect(goalStatusFromHarness("claude", "active", false, "active")).toBe("active");
    expect(goalStatusFromHarness("claude", "met", false, "active")).toBe("achieved");
    expect(goalStatusFromHarness("claude", "failed", false, "active")).toBe("blocked");
    expect(goalStatusFromHarness("claude", "cleared", false, "paused")).toBe("paused");
    expect(goalStatusFromHarness("claude", "cleared", false, "achieved")).toBe("achieved");
    expect(goalStatusFromHarness("claude", "cleared", false, "active")).toBe("cancelled");
    expect(claudeGoalCommand("bun test exits 0")).toBe("/goal bun test exits 0");
    expect(claudeGoalCommand(undefined)).toBe("/goal clear");
  });
});
