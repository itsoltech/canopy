import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@open-agents/contracts";
import { forkable, lastForkPoint } from "./fork-point.ts";

const turn = (id: string, status: string, started = true, inherited = false) =>
  create(ui.TurnSchema, { id, status, inherited, ...(started && { startedAt: timestampFromMs(1) }) });

describe("fork points", () => {
  test("after an ended turn the provider started; never a running, queued or cancelled one", () => {
    expect(["completed", "failed", "interrupted"].map((s) => forkable(turn("t", s)))).toEqual([true, true, true]);
    expect(["running", "queued", "cancelled"].map((s) => forkable(turn("t", s)))).toEqual([false, false, false]);
    // Refused before it started: no point at the provider.
    expect(forkable(turn("t", "failed", false))).toBe(false);
  });

  test("Fork thread: the latest own ended turn, else the latest inherited one", () => {
    const inherited = [turn("i1", "completed", true, true), turn("i2", "completed", true, true)];
    expect(lastForkPoint([turn("a", "completed"), turn("b", "interrupted"), turn("c", "running")], inherited)?.id).toBe("b");
    expect(lastForkPoint([turn("q", "queued")], inherited)?.id).toBe("i2");
    expect(lastForkPoint([], [])).toBeUndefined();
  });
});
