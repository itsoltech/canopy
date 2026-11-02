import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { AgentMessageSchema, ItemSchema, ItemStatus, UserMessageSchema, ui, type Item } from "@open-agents/contracts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-state.svelte.ts";
import { buildTimeline } from "../src/lib/features/threads/timeline.ts";
import { formatDay } from "../src/lib/shared/format.ts";

let seq = 0n;
const entry = (id: string, turnId: string, content: Item["content"]): TimelineEntry => ({
  id,
  item: create(ItemSchema, { itemId: id, status: ItemStatus.COMPLETED, content }),
  turnId,
  firstSeq: ++seq,
  inherited: false,
  fromThreadId: "",
});
const input = (id: string, turnId: string) => entry(id, turnId, { case: "userMessage", value: create(UserMessageSchema, { text: "do it", clientId: turnId }) });
const said = (id: string, turnId: string, text = id) => entry(id, turnId, { case: "agentMessage", value: create(AgentMessageSchema, { text }) });
const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const turn = (id: string, at: number, status = "completed") => create(ui.TurnSchema, { id, ordinal: 1, status, trigger: "user", startedAt: timestampFromMs(at), completedAt: timestampFromMs(at + 5000) });

describe("quiet turn frames", () => {
  test("a turn start marks a new day only where the day changes (the first turn starts one)", () => {
    const turns = [turn("t1", day(2026, 11, 1, 9)), turn("t2", day(2026, 11, 1, 23)), turn("t3", day(2026, 11, 2, 7))];
    const rows = buildTimeline([input("a", "t1"), input("b", "t2"), input("c", "t3")], turns, [], new Map());
    expect(rows.flatMap((r) => (r.kind === "turn-start" ? [[r.turn.id, r.newDay]] : []))).toEqual([["t1", true], ["t2", false], ["t3", true]]);
  });

  test("a turn end carries the turn's last non-empty answer, empty without one", () => {
    const rows = buildTimeline([input("a", "t1"), said("m1", "t1", "first"), said("m2", "t1", "last"), said("m3", "t1", "  "), input("b", "t2")], [turn("t1", day(2026, 11, 2)), turn("t2", day(2026, 11, 2), "failed")], [], new Map());
    expect(rows.flatMap((r) => (r.kind === "turn-end" ? [[r.turn.id, r.answer]] : []))).toEqual([["t1", "last"], ["t2", ""]]);
  });

  test("day labels: today, yesterday, then the date", () => {
    const now = new Date(2026, 10, 2, 8);
    expect(formatDay(timestampFromMs(day(2026, 11, 2, 0)), now)).toBe("Today");
    expect(formatDay(timestampFromMs(day(2026, 11, 1, 23)), now)).toBe("Yesterday");
    expect(formatDay(timestampFromMs(day(2026, 10, 30)), now)).toBe("Oct 30, 2026");
  });
});
