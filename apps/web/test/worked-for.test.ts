import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { AgentMessageSchema, CommandExecutionSchema, FileChangeSchema, ItemSchema, ItemStatus, UserMessageSchema, ui, type Item } from "@open-agents/contracts";
import { FeedBuilder, feedInserted, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-state.svelte.ts";
import { buildTimeline } from "../src/lib/features/threads/timeline.ts";
import { foldTurns, readWork, type FoldedRow } from "../src/lib/features/threads/work-groups.ts";
import { formatSpan } from "../src/lib/shared/format.ts";

let seq = 0n;
const entry = (id: string, turnId: string, content: Item["content"], status = ItemStatus.COMPLETED, extra: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id,
  item: create(ItemSchema, { itemId: id, status, content }),
  turnId,
  firstSeq: ++seq,
  inherited: false,
  fromThreadId: "",
  ...extra,
});
const input = (id: string, turnId: string) => entry(id, turnId, { case: "userMessage", value: create(UserMessageSchema, { text: "do it", clientId: turnId }) });
const steerMsg = (id: string, turnId: string) => entry(id, turnId, { case: "userMessage", value: create(UserMessageSchema, { text: "also this", clientId: `steer-${id}` }) });
const said = (id: string, turnId: string) => entry(id, turnId, { case: "agentMessage", value: create(AgentMessageSchema, { text: id }) });
const ran = (id: string, turnId: string, status = ItemStatus.COMPLETED) => entry(id, turnId, { case: "commandExecution", value: create(CommandExecutionSchema, { command: "ls" }) }, status);
const edited = (id: string, turnId: string) => entry(id, turnId, { case: "fileChange", value: create(FileChangeSchema, {}) });
const turn = (id: string, status: string, over: Partial<ui.Turn> = {}) =>
  create(ui.TurnSchema, { id, ordinal: 1, status, trigger: "user", startedAt: timestampFromMs(1_000_000), completedAt: status === "running" ? undefined : timestampFromMs(1_134_000), ...over });

const fold = (entries: TimelineEntry[], turns: ui.Turn[], open: string[] = []) => foldTurns(buildTimeline(entries, turns, [], new Map()), (id) => open.includes(id));
const shape = (rows: FoldedRow[]) => rows.map((r) => (r.kind === "work" ? `work${r.open ? "+" : ""}` : `${r.work ? "~" : ""}${r.row.kind === "item" ? r.row.node.entry.id : r.row.kind}`));

describe("formatSpan", () => {
  test("seconds, minutes and seconds, hours and minutes", () => {
    expect(formatSpan(12_000)).toBe("12s");
    expect(formatSpan(134_000)).toBe("2m 14s");
    expect(formatSpan(3_780_000)).toBe("1h 3m");
    expect(formatSpan(60_000)).toBe("1m 0s");
  });
  test("never under a second", () => {
    expect(formatSpan(0)).toBe("1s");
    expect(formatSpan(400n)).toBe("1s");
  });
});

describe("folding an ended turn's work", () => {
  const entries = () => [input("in", "t1"), said("m1", "t1"), ran("c1", "t1"), ran("c2", "t1"), edited("e1", "t1"), said("final", "t1")];

  test("a running turn is never folded", () => {
    expect(shape(fold(entries(), [turn("t1", "running")]))).toEqual(["turn-start", "in", "m1", "c1", "c2", "e1", "final"]);
  });

  test("a completed turn keeps its input, the fold, its last message and its footer", () => {
    const rows = fold(entries(), [turn("t1", "completed")]);
    expect(shape(rows)).toEqual(["turn-start", "in", "work", "final", "turn-end"]);
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.key).toBe("work:t1");
    expect(work?.kind === "work" && work.summary).toEqual({ spanMs: 134_000, counts: "2 commands, 1 edit, 1 message", running: 0 });
  });

  test("opened, the work follows the fold and the final message comes after it", () => {
    expect(shape(fold(entries(), [turn("t1", "completed")], ["t1"]))).toEqual(["turn-start", "in", "work+", "~m1", "~c1", "~c2", "~e1", "final", "turn-end"]);
  });

  test("steered messages and running background items go under the fold, counted", () => {
    const rows = fold([input("in", "t1"), ran("c1", "t1", ItemStatus.IN_PROGRESS), steerMsg("s1", "t1"), said("final", "t1")], [turn("t1", "completed")]);
    expect(shape(rows)).toEqual(["turn-start", "in", "work", "final", "turn-end"]);
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && [work.summary.counts, work.summary.running]).toEqual(["1 command, 1 steered message", 1]);
  });

  test("an interrupted turn whose last item is not a message keeps only its footer", () => {
    const rows = fold([input("in", "t1"), said("m1", "t1"), ran("c1", "t1")], [turn("t1", "interrupted")]);
    expect(shape(rows)).toEqual(["turn-start", "in", "work", "turn-end"]);
  });

  test("a failed turn ending on a message keeps that message", () => {
    expect(shape(fold([input("in", "t1"), ran("c1", "t1"), said("m1", "t1")], [turn("t1", "failed")]))).toEqual(["turn-start", "in", "work", "m1", "turn-end"]);
  });

  test("nothing besides the final message: no fold", () => {
    expect(shape(fold([input("in", "t1"), said("final", "t1")], [turn("t1", "completed")]))).toEqual(["turn-start", "in", "final", "turn-end"]);
  });

  test("without timestamps the span is unknown", () => {
    const rows = fold([ran("c1", "t1"), said("final", "t1")], [turn("t1", "completed", { startedAt: undefined })]);
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.summary.spanMs).toBeUndefined();
  });

  test("only ended turns fold: the next running turn stays open", () => {
    const rows = fold([input("in", "t1"), ran("c1", "t1"), said("a", "t1"), input("in2", "t2"), ran("c2", "t2")], [turn("t1", "completed"), turn("t2", "running", { ordinal: 2 })]);
    expect(shape(rows)).toEqual(["turn-start", "in", "work", "a", "turn-end", "turn-start", "in2", "c2"]);
  });
});

describe("the feed with folds", () => {
  const feedInput = (over: Partial<FeedInput>): FeedInput => ({
    entries: [],
    turns: [],
    notices: [],
    results: new Map(),
    queued: [],
    steering: [],
    steers: [],
    working: false,
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set(),
    ...over,
  });

  test("the fold is a row with a stable key; opening it keeps every other row object", () => {
    const entries = [input("in", "t1"), ran("c1", "t1"), said("final", "t1")];
    const turns = [turn("t1", "completed")];
    const builder = new FeedBuilder();
    const closed = builder.build(feedInput({ entries, turns }));
    expect(closed.map((r) => r.key)).toEqual(["start:t1", "item:in", "work:t1", "item:final", "end:t1"]);
    const opened = builder.build(feedInput({ entries, turns, openWork: new Set(["t1"]) }));
    expect(opened.map((r) => r.key)).toEqual(["start:t1", "item:in", "work:t1", "item:c1", "item:final", "end:t1"]);
    expect(opened[0]).toBe(closed[0]!);
    expect(opened[3]!.kind === "timeline" && opened[3]!.work).toBe(true);
    expect(opened.map(feedInserted)).toEqual([undefined, undefined, "reveal", "unfold", undefined, undefined]);
  });

  test("inherited history folds its turns too", () => {
    const inherited = [input("hin", "h1"), ran("hc", "h1"), said("hfinal", "h1")].map((e) => ({ ...e, inherited: true }));
    const rows = new FeedBuilder().build(feedInput({ forkSourceId: "src", inheritedEntries: inherited, inheritedTurns: [turn("h1", "completed")], historyOpen: true }));
    expect(rows.map((r) => r.key)).toEqual(["history", "history:src:start:h1", "history:src:item:hin", "history:src:work:h1", "history:src:item:hfinal", "history:src:end:h1", "forked"]);
    expect(rows.find((r) => r.kind === "work")?.kind === "work" && feedInserted(rows.find((r) => r.kind === "work")!)).toBeUndefined();
  });
});

describe("keeping a fold open for the reader", () => {
  const entries = [input("in", "t1"), said("m1", "t1"), ran("c1", "t1"), steerMsg("s1", "t1"), said("final", "t1"), input("in0", "t0")];

  test("a work row on screen keeps its turn open, held by the first such row", () => {
    expect([...readWork(["t1"], ["item:in", "item:c1", "item:m1"], entries, [])]).toEqual([["t1", "item:c1"]]);
    expect([...readWork(["t1"], ["item:s1"], entries, [])]).toEqual([["t1", "item:s1"]]);
  });

  test("the input and the last message stay anyway: reading them folds", () => {
    expect(readWork(["t1"], ["item:in", "item:final"], entries, []).size).toBe(0);
  });

  test("only turns that just ended", () => {
    expect(readWork(["t0"], ["item:c1"], entries, []).size).toBe(0);
  });

  test("a notice of the turn counts as its work", () => {
    const notice = { seq: 99n, turnId: "t1", notice: {} as never, at: undefined };
    expect([...readWork(["t1"], ["notice:99"], entries, [notice])]).toEqual([["t1", "notice:99"]]);
  });
});
