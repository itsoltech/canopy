import { describe, expect, test } from "bun:test";
import { backgroundEndReason, backgroundOutcome, backgroundStopLabel, backgroundTaskNote, formatDuration, outputTail } from "./background-tasks.ts";

describe("how a background task ended, in words", () => {
  test("outcome from stored and protobuf statuses", () => {
    expect(backgroundOutcome("in_progress")).toBe("running");
    expect(backgroundOutcome("ITEM_STATUS_COMPLETED")).toBe("completed");
    expect(backgroundOutcome("failed")).toBe("failed");
    expect(backgroundOutcome("interrupted")).toBe("interrupted");
  });

  test("stop reasons say who stopped it and why", () => {
    expect(backgroundEndReason("completed", "", 0)).toBe("completed with exit code 0");
    expect(backgroundEndReason("failed", "error", 2)).toBe("failed with exit code 2");
    expect(backgroundEndReason("failed", "error")).toBe("failed");
    expect(backgroundEndReason("interrupted", "stopped_by_user")).toBe("stopped by the user");
    expect(backgroundEndReason("interrupted", "worker_shutdown")).toContain("shut down for a restart or deploy");
    expect(backgroundEndReason("interrupted", "worker_lost")).toContain("crash");
    expect(backgroundEndReason("interrupted", "worker_restart")).toContain("provider runtime was restarted");
    expect(backgroundEndReason("interrupted", "something_new")).toBe("interrupted (something_new)");
    expect(backgroundEndReason("running", "")).toBe("still running");
    expect(backgroundStopLabel("worker_shutdown")).toBe("Stopped: worker restarted for a deploy");
    expect(backgroundStopLabel("unknown")).toBe("unknown");
  });

  test("durations and output tails are bounded", () => {
    expect(formatDuration(42_400)).toBe("42 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatDuration(3_720_000)).toBe("1 h 2 min");
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(outputTail(output, 3)).toEqual({ text: "line 97\nline 98\nline 99", truncated: true });
    expect(outputTail("ok\n")).toEqual({ text: "ok", truncated: false });
    expect(outputTail("x".repeat(10_000), 40, 100).text.length).toBe(100);
  });
});

describe("the platform note", () => {
  const killed = {
    id: "bg:exec-1",
    title: "python3 train.py",
    command: "python3 train.py --epochs 3",
    outcome: "interrupted" as const,
    stopReason: "worker_shutdown",
    startedAt: new Date("2026-11-02T10:00:00Z"),
    endedAt: new Date("2026-11-02T10:01:05Z"),
    output: "epoch 1/3\nepoch 2/3\n",
  };

  test("one task: what, how and why, when, output tail, and how to read more", () => {
    const note = backgroundTaskNote([killed], { tools: true });
    expect(note.startsWith("[open-agents] A background task of this thread ended: stopped because the worker was shut down")).toBe(true);
    expect(note).toContain('Task "python3 train.py" (task_id: bg:exec-1)');
    expect(note).toContain("Command: python3 train.py --epochs 3");
    expect(note).toContain("When: started 2026-11-02T10:00:00.000Z, ended 2026-11-02T10:01:05.000Z, ran 1 min 5 s");
    expect(note).toContain("start it again if it is still needed");
    expect(note).toContain("```\nepoch 1/3\nepoch 2/3\n```");
    expect(note).toContain("get_background_task");
  });

  test("several tasks in one note; exit codes; no tool hint without the bus", () => {
    const done = { ...killed, id: "bg:exec-2", title: "make", command: "make", outcome: "completed" as const, stopReason: "", exitCode: 0, output: "" };
    const note = backgroundTaskNote([killed, done], { tools: false });
    expect(note.startsWith("[open-agents] 2 background tasks of this thread ended.")).toBe(true);
    expect(note).toContain("Outcome: completed with exit code 0");
    expect(note).toContain("Output: (none)");
    expect(note).not.toContain("get_background_task");
  });
});
