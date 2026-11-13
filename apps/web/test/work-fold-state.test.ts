import { describe, expect, test } from "bun:test";
import {
  answerIndex,
  turnProgress,
  workFoldOpen,
  workSegments,
  type WorkFoldPreferences,
  type WorkFoldState,
} from "@canopy/domain/work-fold";
import { planFolds } from "../src/lib/features/threads/work-segments.ts";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ui } from "@canopy/contracts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-types.ts";

const working: WorkFoldState = { live: true, answered: false, answerSeq: undefined };
const answering: WorkFoldState = { live: true, answered: true, answerSeq: 12n };
const ended: WorkFoldState = { ...answering, live: false };

function entry(id: string, seq: bigint, phase?: string, parentItemId = ""): TimelineEntry {
  return {
    id,
    turnId: "turn",
    firstSeq: seq,
    inherited: false,
    fromThreadId: "",
    item: create(ItemSchema, {
      itemId: id,
      parentItemId,
      content:
        phase === undefined
          ? { case: "reasoning", value: { text: "Working" } }
          : { case: "agentMessage", value: { text: "Answer", phase } },
    }),
  };
}

describe("fold boundaries from replayed turn data", () => {
  const turn = create(ui.TurnSchema, { id: "turn", status: "running" });
  const preferences = { expandWhileWorking: true, keepAfterTurn: false };

  test("a late final mark and seq-ordered continuation derive the same folds as a fresh snapshot", () => {
    const work = entry("work", 10n);
    const message = entry("answer", 12n, "");
    const live = planFolds([turn], [work, message], []).folds[0]!;
    const choice = { open: true, state: live };
    const final = entry("answer", 12n, "final_answer");
    const marked = planFolds([turn], [work, final], []).folds[0]!;
    expect(workFoldOpen(marked, preferences, choice)).toBe(false);
    expect(marked.answerSeq).toBe(12n);
    const continuation = entry("continuation", 20n);
    const replay = planFolds([turn], [continuation, final, work], []);
    expect(replay).toEqual(planFolds([turn], [work, final, continuation], []));
    expect(replay.folds.map((fold) => workFoldOpen(fold, preferences, choice))).toEqual([false, true]);
    expect(replay.workOf.get("item:continuation")).toBe("turn/1");
    const completed = planFolds([{ ...turn, status: "completed" }], [work, final, continuation], []);
    expect(completed.folds.map((fold) => workFoldOpen(fold, preferences))).toEqual([false, false]);
  });

  test("nested child answers do not close parent work; missed terminal states do", () => {
    const entries = [entry("parent", 10n), entry("child", 12n, "final_answer", "parent")];
    const live = planFolds([turn], entries, []).folds[0]!;
    expect(workFoldOpen(live, preferences)).toBe(true);
    const choice = { open: true, state: live };

    for (const status of ["completed", "interrupted", "failed", "cancelled"]) {
      const folds = planFolds([{ ...turn, status }], entries, []).folds;
      expect(folds).toHaveLength(1);
      expect(workFoldOpen(folds[0]!, preferences, choice)).toBe(false);
      // Opening the same ended snapshot after reload requires no stored completion event.
      expect(workFoldOpen(folds[0]!, preferences)).toBe(false);
    }
  });
});

describe("turn activity preferences", () => {
  test("the final answer closes expanded work before completion, unless kept open", () => {
    const preferences = { expandWhileWorking: true, keepAfterTurn: false };
    expect(workFoldOpen(working, preferences)).toBe(true);
    expect(workFoldOpen(answering, preferences)).toBe(false);
    expect(workFoldOpen(ended, preferences)).toBe(false);
    expect(workFoldOpen(answering, { ...preferences, keepAfterTurn: true })).toBe(true);
    expect(workFoldOpen(ended, { ...preferences, keepAfterTurn: true })).toBe(true);
  });

  test("collapsed work can open for the answer, and unphased turns wait for completion", () => {
    const preferences = { expandWhileWorking: false, keepAfterTurn: true };
    expect(workFoldOpen(working, preferences)).toBe(false);
    expect(workFoldOpen(answering, preferences)).toBe(true);
    expect(workFoldOpen({ ...working, live: false }, preferences)).toBe(true);
    expect(workFoldOpen(working, { ...preferences, expandWhileWorking: true, keepAfterTurn: false })).toBe(true);
    expect(workFoldOpen({ ...working, live: false }, { ...preferences, keepAfterTurn: false })).toBe(false);
  });

  test("manual choices last within their boundary, including preference changes", () => {
    const modes: WorkFoldPreferences[] = [
      { expandWhileWorking: true, keepAfterTurn: false },
      { expandWhileWorking: true, keepAfterTurn: true },
      { expandWhileWorking: false, keepAfterTurn: false },
      { expandWhileWorking: false, keepAfterTurn: true },
    ];

    for (const preferences of modes)
      for (const manual of [false, true]) {
        for (const state of [working, answering, ended])
          expect(workFoldOpen(state, preferences, { open: manual, state })).toBe(manual);
      }
  });

  test("live expansion expires at the answer and terminal state, even if updates were skipped", () => {
    const preferences = { expandWhileWorking: true, keepAfterTurn: false };
    const duringWork = { open: true, state: working };
    expect(workFoldOpen(answering, preferences, duringWork)).toBe(false);
    expect(workFoldOpen(ended, preferences, duringWork)).toBe(false);
    expect(workFoldOpen(ended, preferences, { open: true, state: answering })).toBe(false);
    // Reopening after the end stays open through late answer marks and transcript items.
    expect(workFoldOpen({ ...ended, answerSeq: 18n }, preferences, { open: true, state: ended })).toBe(true);
    expect(workFoldOpen(ended, preferences)).toBe(false);
  });

  test("a final answer sequence scopes choices independently of later deltas or continuation segments", () => {
    const preferences = { expandWhileWorking: true, keepAfterTurn: false };
    const choice = { open: true, state: answering };
    expect(workFoldOpen({ ...answering }, preferences, choice)).toBe(true);
    expect(workFoldOpen({ ...answering, answerSeq: 25n }, preferences, choice)).toBe(false);
    expect(workFoldOpen(working, preferences)).toBe(true);
    expect(workFoldOpen({ ...answering, live: false }, preferences, choice)).toBe(false);
  });

  test("every terminal outcome closes work without needing a final answer or a prior live render", () => {
    const preferences = { expandWhileWorking: true, keepAfterTurn: false };

    for (const status of ["completed", "interrupted", "failed", "cancelled"])
      expect(
        workFoldOpen({ ...working, live: turnProgress(status) === "live" }, preferences, {
          open: true,
          state: working,
        }),
      ).toBe(false);
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
      { start: 0, end: 2, inputs: 0, answer: 1, live: true, answered: true, answerBoundary: 1 },
    ]);
    expect(workSegments([tool, final, tool], "live", closed)).toEqual([
      { start: 0, end: 2, inputs: 0, answer: 1, live: false, answered: true, answerBoundary: 1 },
      { start: 2, end: 3, inputs: 0, answer: -1, live: true, answered: false, answerBoundary: -1 },
    ]);
    // Completed: both keep their answers; an unphased last message is the second one's.
    expect(workSegments([tool, final, tool, unphased], "completed", closed).map((s) => s.answer)).toEqual([1, 3]);
  });

  test("a steer after the answer leads the next segment, above its fold", () => {
    const [first, second] = workSegments([tool, final, steer, tool, final], "live", closed);
    expect(first).toMatchObject({ answer: 1, inputs: 0 });
    expect(second).toEqual({ start: 2, end: 5, inputs: 1, answer: 4, live: true, answered: true, answerBoundary: 4 });
    // A steer also splits running work, without expiring its live choices.
    expect(workSegments([tool, steer, tool], "live", closed)).toMatchObject([
      { start: 0, end: 1, inputs: 0, answer: -1, live: true },
      { start: 1, end: 3, inputs: 1, answer: -1, live: true },
    ]);
  });

  test("an interrupted second segment keeps the first answer and follows the turn-end rule", () => {
    expect(workSegments([tool, final, tool, unphased, tool], "ended", closed).map((s) => s.answer)).toEqual([1, -1]);
    expect(workSegments([tool, final, tool, unphased], "ended", closed).map((s) => s.answer)).toEqual([1, 3]);
    // Only the last segment's fold decides whether an unconfirmed message shows while live.
    expect(workSegments([final, tool, unphased], "live", (i) => i === 1).map((s) => s.answer)).toEqual([0, 2]);
    expect(workSegments([final, tool, unphased], "live", (i) => i === 0).map((s) => s.answer)).toEqual([0, -1]);
  });
});
