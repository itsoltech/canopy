import { describe, expect, test } from "bun:test";
import { answerIndex, workFoldOpen, workSegments, type WorkFoldPreferences } from "@canopy/domain/work-fold";

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

describe("segments after a shown answer", () => {
  const tool = { phase: undefined, steer: false };
  const steer = { phase: undefined, steer: true };
  const final = { phase: "final_answer", steer: false };
  const unphased = { phase: "", steer: false };
  const closed = () => false;

  test("work after a confirmed answer starts a new segment and the answer stays", () => {
    expect(workSegments([tool, final], "live", closed)).toEqual([
      { start: 0, end: 2, inputs: 0, answer: 1, live: true, answered: true },
    ]);
    expect(workSegments([tool, final, tool], "live", closed)).toEqual([
      { start: 0, end: 2, inputs: 0, answer: 1, live: false, answered: true },
      { start: 2, end: 3, inputs: 0, answer: -1, live: true, answered: false },
    ]);
    // Completed: both keep their answers; an unphased last message is the second one's.
    expect(workSegments([tool, final, tool, unphased], "completed", closed).map((s) => s.answer)).toEqual([1, 3]);
  });

  test("a steer after the answer leads the next segment, above its fold", () => {
    const [first, second] = workSegments([tool, final, steer, tool, final], "live", closed);
    expect(first).toMatchObject({ answer: 1, inputs: 0 });
    expect(second).toEqual({ start: 2, end: 5, inputs: 1, answer: 4, live: true, answered: true });
    // A steer inside running work stays in the fold.
    expect(workSegments([tool, steer, tool], "live", closed)[0]).toMatchObject({ inputs: 0, answer: -1 });
  });

  test("an interrupted second segment keeps the first answer and follows the turn-end rule", () => {
    expect(workSegments([tool, final, tool, unphased, tool], "ended", closed).map((s) => s.answer)).toEqual([1, -1]);
    expect(workSegments([tool, final, tool, unphased], "ended", closed).map((s) => s.answer)).toEqual([1, 3]);
    // Only the last segment's fold decides whether an unconfirmed message shows while live.
    expect(workSegments([final, tool, unphased], "live", (i) => i === 1).map((s) => s.answer)).toEqual([0, 2]);
    expect(workSegments([final, tool, unphased], "live", (i) => i === 0).map((s) => s.answer)).toEqual([0, -1]);
  });
});
