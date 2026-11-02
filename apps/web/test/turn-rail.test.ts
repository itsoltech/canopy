import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ui } from "@open-agents/contracts";
import { FeedBuilder, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-state.svelte.ts";
import { currentTurns, railTicks, railTurns } from "../src/lib/features/threads/rail/turn-rail.ts";
import { snippetTokens } from "../src/lib/shared/ui/markdown/tokens.ts";

describe("turn rail layout", () => {
  test("short threads have one evenly spaced tick per turn", () => {
    expect(railTicks(3, 30)).toEqual([
      { start: 0, end: 1, y: 5 }, { start: 1, end: 2, y: 15 }, { start: 2, end: 3, y: 25 },
    ]);
    expect(railTicks(0, 30)).toEqual([]);
    expect(railTicks(50, 0)).toEqual([]);
  });
  test("500+ turns merge into bounded ticks, with no lost or duplicated turns", () => {
    for (const count of [501, 10000]) for (const height of [1, 67, 640]) {
      const ticks = railTicks(count, height);
      expect(ticks.length).toBeLessThanOrEqual(Math.max(1, Math.floor(height / 4)));
      expect(ticks[0]!.start).toBe(0);
      expect(ticks.at(-1)!.end).toBe(count);
      ticks.forEach((tick, index) => {
        expect(tick.y).toBeGreaterThanOrEqual(0);
        expect(tick.y).toBeLessThan(height);
        expect(tick.end).toBeGreaterThan(tick.start);
        if (index) expect(tick.start).toBe(ticks[index - 1]!.end);
      });
    }
  });
  test("marks only turns intersecting actual visible rows, including the middle of long work", () => {
    const turns = [{ start: 2 }, { start: 10 }, { start: 900 }, { start: 950 }];
    expect(currentTurns(turns, { start: 0, end: 2 })).toEqual([0, 0]);
    expect(currentTurns(turns, { start: 2, end: 10 })).toEqual([0, 1]);
    expect(currentTurns(turns, { start: 500, end: 600 })).toEqual([1, 2]);
    expect(currentTurns(turns, { start: 895, end: 920 })).toEqual([1, 3]);
    expect(currentTurns(turns, { start: 950, end: 960 })).toEqual([3, 4]);
    expect(currentTurns([], { start: 0, end: 5 })).toEqual([0, 0]);
    expect(currentTurns(turns, { start: 20, end: 20 })).toEqual([0, 0]);
  });
});

const turn = (id: string, ordinal: number, status = "completed") => create(ui.TurnSchema, {
  id, ordinal, status, inputText: `Question **${ordinal}**\nwith details`, startedAt: timestampFromMs(1700000000000),
});
const entry = (id: string, turnId: string, seq: bigint, content: Parameters<typeof create<typeof ItemSchema>>[1]["content"]): TimelineEntry => ({
  id, turnId, firstSeq: seq, inherited: false, fromThreadId: "", item: create(ItemSchema, { itemId: id, content }),
});
const input = (over: Partial<FeedInput> = {}): FeedInput => ({
  entries: [], turns: [], notices: [], results: new Map(), steering: [], working: false,
  inheritedEntries: [], inheritedTurns: [], historyOpen: false, openWork: new Set(), ...over,
});

describe("turn preview and feed mapping", () => {
  test("jumps to the echoed user input, keeps final markdown and time, ignores steers", () => {
    const turns = [turn("t1", 1), turn("t2", 2, "running")];
    const entries = [
      entry("u1", "t1", 1n, { case: "userMessage", value: { text: "Echoed **question**", clientId: "t1" } }),
      entry("comment", "t1", 2n, { case: "agentMessage", value: { text: "Earlier work", phase: "commentary" } }),
      entry("final", "t1", 3n, { case: "agentMessage", value: { text: "**Final** answer with `code`.", phase: "final_answer" } }),
      entry("steer", "t2", 4n, { case: "userMessage", value: { text: "A steer", clientId: "steer-id" } }),
      entry("live", "t2", 5n, { case: "agentMessage", value: { text: "Live preview", phase: "commentary" } }),
    ];
    const rows = new FeedBuilder().build(input({ turns, entries, working: true }));
    const rail = railTurns(rows);
    expect(rail).toHaveLength(2);
    expect(rows[rail[0]!.row]!.key).toBe("item:u1");
    expect(rail[0]!.title).toBe("Echoed **question**");
    expect(rail[0]!.answer).toBe("**Final** answer with `code`.");
    expect(snippetTokens(rail[0]!.answer).some((t) => t.type === "strong")).toBe(true);
    expect(rail[0]!.time).toEqual(turns[0]!.startedAt);
    expect(rail[1]!.running).toBe(true);
    expect(rail[1]!.title).toBe("Question **2** with details");
    expect(rows[rail[1]!.row]!.key).toBe("input:t2");
    expect(rail[1]!.answer).toBe("Live preview");
  });
  test("opening a work fold updates row indices without changing previews", () => {
    const builder = new FeedBuilder();
    const data = input({ turns: [turn("a", 1), turn("b", 2)], entries: [
      entry("work1", "a", 1n, { case: "agentMessage", value: { text: "work" } }),
      entry("work2", "a", 2n, { case: "agentMessage", value: { text: "more work" } }),
      entry("answer", "a", 3n, { case: "agentMessage", value: { text: "answer" } }),
      entry("b-answer", "b", 4n, { case: "agentMessage", value: { text: "second" } }),
    ] });
    const closed = railTurns(builder.build(data));
    const opened = railTurns(builder.build({ ...data, openWork: new Set(["a"]) }));
    expect(opened[1]!.row).toBeGreaterThan(closed[1]!.row);
    expect(opened.map((t) => t.answer)).toEqual(closed.map((t) => t.answer));
  });
  test("queued/withdrawn turns stay off the rail; empty and oversized content has bounded previews", () => {
    const rail = railTurns(new FeedBuilder().build(input({ turns: [
      { ...turn("empty", 1), inputText: "" }, { ...turn("long", 2), inputText: "x".repeat(10000) },
      turn("queued", 3, "queued"), { ...turn("withdrawn", 4), withdrawn: true },
    ] })));
    expect(rail.map((t) => t.id)).toEqual(["empty", "long"]);
    expect(rail[0]!.title).toBe("Message with attachments");
    expect(rail[0]!.answer).toBe("");
    expect(rail[1]!.title.length).toBe(240);
  });
});
