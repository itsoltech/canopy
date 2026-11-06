import { describe, expect, test } from "bun:test";
import { answerIndex, workFoldOpen, type WorkFoldPreferences } from "@canopy/domain/work-fold";

describe("turn activity preferences", () => {
  test("the final answer closes expanded work before completion, unless kept open", () => {
    const preferences = { expandWhileWorking: true, keepAfterTurn: false };
    expect(workFoldOpen(true, false, preferences)).toBe(true);
    expect(workFoldOpen(true, true, preferences)).toBe(false);
    expect(workFoldOpen(false, true, preferences)).toBe(false);
    expect(workFoldOpen(true, true, { ...preferences, keepAfterTurn: true })).toBe(true);
    expect(workFoldOpen(false, true, { ...preferences, keepAfterTurn: true })).toBe(true);
  });

  test("collapsed work can open for the answer, and unphased turns wait for completion", () => {
    const preferences = { expandWhileWorking: false, keepAfterTurn: true };
    expect(workFoldOpen(true, false, preferences)).toBe(false);
    expect(workFoldOpen(true, true, preferences)).toBe(true);
    expect(workFoldOpen(false, false, preferences)).toBe(true);
    expect(workFoldOpen(true, false, { ...preferences, expandWhileWorking: true, keepAfterTurn: false })).toBe(true);
    expect(workFoldOpen(false, false, { ...preferences, keepAfterTurn: false })).toBe(false);
  });

  test("manual choices survive answer start, completion and preference changes", () => {
    const modes: WorkFoldPreferences[] = [
      { expandWhileWorking: true, keepAfterTurn: false },
      { expandWhileWorking: true, keepAfterTurn: true },
      { expandWhileWorking: false, keepAfterTurn: false },
      { expandWhileWorking: false, keepAfterTurn: true },
    ];

    for (const preferences of modes)
      for (const manual of [false, true]) {
        expect(workFoldOpen(true, false, preferences, manual)).toBe(manual);
        expect(workFoldOpen(true, true, preferences, manual)).toBe(manual);
        expect(workFoldOpen(false, true, preferences, manual)).toBe(manual);
      }
  });

  test("an active reader keeps work open, but can still manually collapse it", () => {
    const preferences = { expandWhileWorking: true, keepAfterTurn: false };
    expect(workFoldOpen(true, true, preferences, undefined, true)).toBe(true);
    expect(workFoldOpen(false, true, preferences, undefined, true)).toBe(true);
    expect(workFoldOpen(false, true, preferences, false, true)).toBe(false);
  });

  test("a collapsed live turn keeps unconfirmed messages in its work until a phase or the end confirms them", () => {
    const tool = undefined;
    expect(answerIndex([tool, ""], "live", false)).toBe(-1);
    expect(answerIndex([tool, ""], "live", true)).toBe(1);
    expect(answerIndex([tool, "commentary"], "live", true)).toBe(-1);
    expect(answerIndex([tool, "final_answer"], "live", false)).toBe(1);
    expect(answerIndex(["", tool], "live", true)).toBe(-1);
    expect(answerIndex([tool, ""], "completed", false)).toBe(1);
    expect(answerIndex(["", tool], "completed", false)).toBe(0);
    expect(answerIndex(["", tool], "ended", false)).toBe(-1);
    expect(answerIndex([tool, "commentary"], "ended", false)).toBe(1);
  });
});
