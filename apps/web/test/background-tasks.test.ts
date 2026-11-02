import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BackgroundTaskSchema, ItemSchema, ItemStatus } from "@open-agents/contracts";
import { backgroundStatus, backgroundTasks, OUTPUT_LINE_HEIGHT, outputRange, OutputPin, visibleTasks } from "../src/lib/features/threads/background-tasks.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-state.svelte.ts";

const entry = (id: string, seq: bigint, status = ItemStatus.IN_PROGRESS, turnId = ""): TimelineEntry => ({
  id, firstSeq: seq, turnId, inherited: false, fromThreadId: "",
  item: create(ItemSchema, { itemId: id, status, content: { case: "backgroundTask", value: create(BackgroundTaskSchema, { command: "sleep 60" }) } }),
});

describe("background task list", () => {
  test("running first, newest first within each group, including tasks without a turn", () => {
    const tasks = [entry("done", 10n, ItemStatus.COMPLETED), entry("old-running", 1n), entry("new-running", 4n), entry("failed", 9n, ItemStatus.FAILED), entry("inherited", 15n)];
    tasks[4] = { ...tasks[4]!, inherited: true };
    const sorted = backgroundTasks(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["new-running", "old-running", "done", "failed"]);
    expect(tasks[0]?.id).toBe("done");
  });

  test("keeps every running task and three recent finished tasks, and expands the rest", () => {
    const sorted = backgroundTasks([entry("r", 1n), ...Array.from({ length: 6 }, (_, i) => entry(`d${i}`, BigInt(i + 2), ItemStatus.COMPLETED))]);
    expect(visibleTasks(sorted, false).map((t) => t.id)).toEqual(["r", "d5", "d4", "d3"]);
    expect(visibleTasks(sorted, true)).toHaveLength(7);
  });

  test("distinguishes done, failure, user and system stops without inventing exit codes", () => {
    const done = backgroundTasks([entry("d", 1n, ItemStatus.COMPLETED)])[0]!;
    expect(backgroundStatus(done)).toBe("Done · exit unavailable");
    expect(backgroundStatus(done, 0)).toBe("Done · exit 0");
    const failed = backgroundTasks([entry("f", 2n, ItemStatus.FAILED)])[0]!;
    expect(backgroundStatus(failed, 1)).toBe("Failed · exit 1");
    const stopped = backgroundTasks([entry("s", 3n, ItemStatus.INTERRUPTED)])[0]!;
    expect(backgroundStatus(stopped)).toBe("Stopped by system");
    stopped.item.content.value.stopReason = "stopped_by_user";
    expect(backgroundStatus(stopped)).toBe("Stopped by you");
  });
});

describe("output tail", () => {
  test("growth alone never releases the pin; scrolling up does, End re-pins", () => {
    const pin = new OutputPin();
    expect(pin.latest(400, 1000)).toBe(600);
    pin.scroll(600, 400, 1200);
    expect(pin.pinned).toBe(true);
    pin.scroll(500, 400, 1200);
    expect(pin.pinned).toBe(false);
    pin.scroll(500, 400, 1500);
    expect(pin.pinned).toBe(false);
    expect(pin.latest(400, 1500)).toBe(1100);
    expect(pin.pinned).toBe(true);
  });

  test("manually reaching the bottom re-pins; small output starts at zero", () => {
    const pin = new OutputPin();
    pin.latest(400, 1000);
    pin.scroll(100, 400, 1000);
    pin.scroll(600, 400, 1000);
    expect(pin.pinned).toBe(true);
    expect(pin.latest(400, 100)).toBe(0);
  });

  test("100,000 lines mount only the viewport plus overscan, at start, middle and tail", () => {
    for (const top of [0, 50_000 * OUTPUT_LINE_HEIGHT, 100_000 * OUTPUT_LINE_HEIGHT - 400]) {
      const [start, end] = outputRange(100_000, top, 400);
      expect(end - start).toBeLessThanOrEqual(36);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(100_000);
    }
    expect(outputRange(0, 0, 400)).toEqual([0, 0]);
  });
});
