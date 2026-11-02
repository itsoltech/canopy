import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { AgentMessageSchema, BackgroundTaskSchema, CommandExecutionSchema, FileChangeSchema, ItemSchema, ItemStatus, ReasoningSchema, ToolCallSchema, UserMessageSchema, ui, type Item } from "@open-agents/contracts";
import { FeedBuilder, feedInserted, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-state.svelte.ts";
import { buildTimeline } from "../src/lib/features/threads/timeline.ts";
import { foldTurns, readWork, currentWorkHint, groupSummary, type FoldedRow } from "../src/lib/features/threads/work-groups.ts";
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
const shape = (rows: FoldedRow[]) => rows.flatMap((r) => {
  if (r.kind === "work") return [`work${r.open ? "+" : ""}`];
  if (r.kind === "work-group") return [`group:${r.label}`];
  if (r.kind === "answer") return r.row?.kind === "item" ? [r.row.node.entry.id] : [];
  return [`${r.work ? "~" : ""}${r.row.kind === "item" ? r.row.node.entry.id : r.row.kind}`];
});

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

  test("a running turn starts with the same collapsed fold as an ended one", () => {
    expect(shape(fold(entries(), [turn("t1", "running")]))).toEqual(["turn-start", "in", "work", "final"]);
    expect(shape(fold([], [turn("t1", "running")]))).toEqual(["turn-start", "work"]);
  });

  test("a completed turn keeps its input, the fold, its last message and its footer", () => {
    const rows = fold(entries(), [turn("t1", "completed")]);
    expect(shape(rows)).toEqual(["turn-start", "in", "work", "final", "turn-end"]);
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.key).toBe("work:t1");
    expect(work?.kind === "work" && work.summary).toMatchObject({ spanMs: 134_000, counts: "2 commands, 1 edit, 1 message", running: 0, live: false });
  });

  test("opened, the work follows the fold and the final message comes after it", () => {
    expect(shape(fold(entries(), [turn("t1", "completed")], ["t1"]))).toEqual(["turn-start", "in", "work+", "~m1", "group:Ran 2 commands and made 1 edit", "final", "turn-end"]);
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

  test("empty reasoning (Codex's encrypted-only reasoning) adds no work to the fold", () => {
    const start = input("in", "t1");
    const blank = entry("r1", "t1", { case: "reasoning", value: create(ReasoningSchema, {}) });
    expect(shape(fold([start, blank, said("final", "t1")], [turn("t1", "completed")]))).toEqual(["turn-start", "in", "work", "final", "turn-end"]);
  });

  test("empty reasoning stays hidden while the live fold still shows thinking", () => {
    const start = input("in", "t1");
    const blank = entry("r1", "t1", { case: "reasoning", value: create(ReasoningSchema, {}) });
    expect(shape(fold([start, blank], [turn("t1", "running")]))).toEqual(["turn-start", "in", "work"]);
  });

  test("a message-only turn retains its fold and answer slot at completion", () => {
    expect(shape(fold([input("in", "t1"), said("final", "t1")], [turn("t1", "completed")]))).toEqual(["turn-start", "in", "work", "final", "turn-end"]);
  });

  test("without timestamps the span is unknown", () => {
    const rows = fold([ran("c1", "t1"), said("final", "t1")], [turn("t1", "completed", { startedAt: undefined })]);
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.summary.spanMs).toBeUndefined();
  });

  test("each turn has its own fold, including the next running turn", () => {
    const rows = fold([input("in", "t1"), ran("c1", "t1"), said("a", "t1"), input("in2", "t2"), ran("c2", "t2")], [turn("t1", "completed"), turn("t2", "running", { ordinal: 2 })]);
    expect(shape(rows)).toEqual(["turn-start", "in", "work", "a", "turn-end", "turn-start", "in2", "work"]);
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

  test("a live background task owns its source's running count, including system stops outside the turn", () => {
    for (const taskTurn of ["t1", ""]) {
      for (const status of [ItemStatus.INTERRUPTED, ItemStatus.COMPLETED, ItemStatus.FAILED]) {
        const builder = new FeedBuilder();
        const command = ran("source", "t1", ItemStatus.IN_PROGRESS);
        const task = entry("bg", taskTurn, { case: "backgroundTask", value: create(BackgroundTaskSchema, { sourceItemId: "source", startedInTurnId: "t1" }) }, ItemStatus.IN_PROGRESS);
        const entries = [input("in", "t1"), command, task, said("final", "t1")];
        const turns = [turn("t1", "completed")];
        const before = builder.build(feedInput({ entries, turns })).find((row) => row.kind === "work")!;
        expect(before.kind === "work" && before.summary.running).toBe(1);
        const finished = { ...task, item: create(ItemSchema, { ...task.item, status, content: { case: "backgroundTask", value: create(BackgroundTaskSchema, { sourceItemId: "source", stopReason: status === ItemStatus.INTERRUPTED ? "stopped" : "" }) } }) };
        const after = builder.build(feedInput({ entries: entries.map((e) => e === task ? finished : e), turns })).find((row) => row.kind === "work")!;
        expect(after.kind === "work" && after.summary.running).toBe(0);
        expect(after).not.toBe(before);
      }
    }
  });

  test("nested tool sources follow background status while independent running tasks remain counted", () => {
    const source = ran("source", "t1", ItemStatus.IN_PROGRESS);
    source.item.parentItemId = "parent";
    const parent = ran("parent", "t1");
    const task = entry("bg", "t1", { case: "backgroundTask", value: create(BackgroundTaskSchema, { sourceItemId: "source" }) }, ItemStatus.INTERRUPTED);
    const other = entry("other", "t1", { case: "backgroundTask", value: create(BackgroundTaskSchema) }, ItemStatus.IN_PROGRESS);
    const work = fold([parent, source, task, other], [turn("t1", "completed")]).find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.summary.running).toBe(1);
  });

  test("the fold is a row with a stable key; opening it keeps every other row object", () => {
    const entries = [input("in", "t1"), ran("c1", "t1"), said("final", "t1")];
    const turns = [turn("t1", "completed")];
    const builder = new FeedBuilder();
    const closed = builder.build(feedInput({ entries, turns }));
    expect(closed.map((r) => r.key)).toEqual(["start:t1", "item:in", "work:t1", "answer:t1", "end:t1"]);
    const opened = builder.build(feedInput({ entries, turns, openWork: new Set(["t1"]) }));
    expect(opened.map((r) => r.key)).toEqual(["start:t1", "item:in", "work:t1", "group:t1:item:c1", "answer:t1", "end:t1"]);
    expect(opened[0]).toBe(closed[0]!);
    expect(opened[3]!.kind).toBe("work-group");
    expect(opened.map(feedInserted)).toEqual([undefined, undefined, "reveal", undefined, undefined, undefined]);
    const tools = builder.build(feedInput({ entries, turns, openWork: new Set(["t1"]), openGroups: new Set(["group:t1:item:c1"]) }));
    expect(tools.some((r) => r.key === "item:c1")).toBe(true);
  });

  test("inherited history folds its turns too", () => {
    const inherited = [input("hin", "h1"), ran("hc", "h1"), said("hfinal", "h1")].map((e) => ({ ...e, inherited: true }));
    const rows = new FeedBuilder().build(feedInput({ forkSourceId: "src", inheritedEntries: inherited, inheritedTurns: [turn("h1", "completed")], historyOpen: true }));
    expect(rows.map((r) => r.key)).toEqual(["history", "history:src:start:h1", "history:src:item:hin", "history:src:work:h1", "history:src:answer:h1", "history:src:end:h1", "forked"]);
    expect(rows.find((r) => r.kind === "work")?.kind === "work" && feedInserted(rows.find((r) => r.kind === "work")!)).toBeUndefined();
  });
});

describe("live work and tool groups", () => {
  const read = (id: string, status = ItemStatus.COMPLETED) => entry(id, "t1", { case: "toolCall", value: create(ToolCallSchema, { name: "Read", inputJson: '{"file_path":"/repo/app.ts"}' }) }, status);
  const body = (entries: TimelineEntry[]) => buildTimeline(entries, [turn("t1", "running")], [], new Map()).filter((r) => r.kind === "item");

  test("groups describe mixed calls in order, with singular/plural text", () => {
    expect(groupSummary(body([read("r1"), ...Array.from({ length: 5 }, (_, i) => ran(`c${i}`, "t1"))]))).toBe("Read 1 file and ran 5 commands");
    expect(groupSummary(body([read("r1"), read("r2")]))).toBe("Read 2 files");
  });

  test("live hint follows active calls and ignores completed calls", () => {
    expect(currentWorkHint(body([read("r1", ItemStatus.IN_PROGRESS), read("r2", ItemStatus.IN_PROGRESS)]))).toBe("Reading 2 files…");
    expect(currentWorkHint(body([read("r1")]))).toBe("Thinking…");
    const command = ran("cmd", "t1", ItemStatus.IN_PROGRESS);
    if (command.item.content.case === "commandExecution") command.item.content.value.command = "bun test";
    expect(currentWorkHint(body([read("r1"), command]))).toBe("Running bun test…");
  });

  test("latest message moves inside when tools resume; answer slot and group keys stay stable", () => {
    const start = [input("in", "t1"), read("r1"), said("progress", "t1")];
    const live = fold(start, [turn("t1", "running")], ["t1"]);
    expect(shape(live)).toEqual(["turn-start", "in", "work+", "group:Read 1 file", "progress"]);
    const continued = [...start, ran("test", "t1")];
    expect(shape(fold(continued, [turn("t1", "running")], ["t1"]))).toEqual(["turn-start", "in", "work+", "group:Read 1 file", "~progress", "group:Ran 1 command"]);
    const final = [...continued, said("answer", "t1")];
    const before = fold(final, [turn("t1", "running")], ["t1"]);
    const after = fold(final, [turn("t1", "completed")], ["t1"]);
    expect(shape(after).slice(0, -1)).toEqual(shape(before));
    expect(before.find((r) => r.kind === "answer")?.key).toBe(after.find((r) => r.kind === "answer")?.key);
  });

  test("an encrypted/empty message does not replace the visible answer", () => {
    const blank = entry("blank", "t1", { case: "agentMessage", value: create(AgentMessageSchema) });
    expect(shape(fold([said("answer", "t1"), blank], [turn("t1", "completed")]))).toEqual(["turn-start", "work", "answer", "turn-end"]);
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
