import { describe, expect, test } from "bun:test";
import { observedSummaryTurns } from "./notification-observation.ts";

describe("notification consumption from explicit summaries", () => {
  const summary = (id: string, status = "completed") => ({
    last_turn: { turn_id: id, status },
    last_message: "result",
  });

  test("get_thread includes the finished turn and its result, even if another turn is running", () => {
    for (const status of ["completed", "failed", "interrupted", "cancelled"]) {
      expect(observedSummaryTurns("get_thread", { ...summary("target", status), settled: false })).toEqual(["target"]);
    }

    expect(observedSummaryTurns("get_thread", { ...summary("empty"), last_message: "" })).toEqual(["empty"]);
  });

  test("wait_threads consumes only finished results actually returned, including partial/time-out results", () => {
    expect(
      observedSummaryTurns("wait_threads", {
        done: false,
        threads: [summary("ended"), summary("busy", "running"), { settled: false }],
      }),
    ).toEqual(["ended"]);
    expect(observedSummaryTurns("wait_threads", { done: true, threads: [summary("a"), summary("b")] })).toEqual([
      "a",
      "b",
    ]);
  });

  test("listings, missing results, in-progress results and read_thread pages are not summary observations", () => {
    expect(observedSummaryTurns("list_threads", { threads: [summary("target")] })).toEqual([]);
    expect(observedSummaryTurns("get_thread", { last_turn: { turn_id: "target", status: "completed" } })).toEqual([]);
    expect(observedSummaryTurns("get_thread", summary("target", "running"))).toEqual([]);
    expect(observedSummaryTurns("read_thread", { entries: [summary("target")] })).toEqual([]);
    expect(observedSummaryTurns("wait_threads", undefined)).toEqual([]);
  });
});
