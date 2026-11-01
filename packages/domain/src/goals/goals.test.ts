import { describe, expect, test } from "bun:test";
import { claudeGoalCommand, fromCodexStatus, goalStatusAfterFailure, goalStatusFromHarness, type CodexGoalStatus } from "./goals.ts";

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

  test("a failed goal command falls back to the harness's last report; an unconfirmed goal is blocked", () => {
    expect(goalStatusAfterFailure("codex", "")).toBe("blocked");
    expect(goalStatusAfterFailure("codex", "active")).toBe("active");
    expect(goalStatusAfterFailure("codex", "paused")).toBe("paused");
    expect(goalStatusAfterFailure("codex", "budgetLimited")).toBe("budget_limited");
    expect(goalStatusAfterFailure("codex", "cleared")).toBe("cancelled");
    expect(goalStatusAfterFailure("claude", "active")).toBe("active");
  });
});
