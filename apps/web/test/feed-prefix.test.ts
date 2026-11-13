import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ItemStatus, NoticeSchema, ui } from "@canopy/contracts";
import { FeedPrefix } from "../src/lib/features/threads/feed-prefix.ts";
import type { FeedInput, FeedRow } from "../src/lib/features/threads/feed.ts";
import { FeedBuilder, feedScrollKey } from "../src/lib/features/threads/feed.ts";
import { buildTimeline } from "../src/lib/features/threads/timeline.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-types.ts";

const turn = (id: string, ordinal: number, status = "completed", day = 1) =>
  create(ui.TurnSchema, { id, ordinal, status, startedAt: timestampFromMs(Date.UTC(2026, 0, day)) });

const entry = (id: string, turnId: string, seq: bigint, parentItemId = ""): TimelineEntry => ({
  id,
  turnId,
  firstSeq: seq,
  inherited: false,
  fromThreadId: "",
  item: create(ItemSchema, {
    itemId: id,
    parentItemId,
    status: ItemStatus.COMPLETED,
    content: { case: "agentMessage", value: { text: id } },
  }),
});

const input = (): FeedInput => ({
  entries: [entry("old", "a", 1n), entry("live", "b", 2n)],
  turns: [turn("a", 1), turn("b", 2, "running")],
  notices: [],
  results: new Map(),
  steering: [],
  working: true,
  inheritedEntries: [],
  inheritedTurns: [],
  historyOpen: false,
  openWork: new Set(),
});

const build = (part: FeedInput, context?: { lastDay: string; withdrawn: readonly number[] }): FeedRow[] =>
  buildTimeline(part.entries, part.turns, part.notices, part.results, undefined, context).map((row) => ({
    kind: "timeline",
    key: row.key,
    row,
    history: false,
    last: false,
    work: false,
  }));

test("reading anchors follow their message when an answer slot is replaced, including inherited history", () => {
  for (const inherited of [false, true]) {
    const builder = new FeedBuilder();
    const base = input();

    const state = (ended: boolean): FeedInput => {
      const entries = [...base.entries, ...(ended ? [entry("final", "b", 3n)] : [])];
      const turns = ended ? base.turns.map((t) => ({ ...t, status: "completed" })) : base.turns;

      return {
        ...base,
        entries: inherited ? [] : entries,
        turns: inherited ? [] : turns,
        inheritedEntries: inherited ? entries : [],
        inheritedTurns: inherited ? turns : [],
        forkSourceId: inherited ? "source" : undefined,
        historyOpen: true,
        openWork: new Set(["b"]),
      };
    };

    const answer = builder.build(state(false)).find((row) => row.kind === "answer" && row.turn.id === "b");

    if (!answer) throw new Error("Expected the provisional answer");
    const saved = feedScrollKey(answer);
    const next = builder.build(state(true));
    const restored = next.find((row) => feedScrollKey(row) === saved);
    expect(restored?.key).toBe(`${inherited ? "history:source:" : ""}item:live`);
    expect(next.find((row) => row.key === answer.key)).toBeDefined();
    expect(feedScrollKey(next.find((row) => row.key === answer.key) ?? answer)).not.toBe(saved);
  }
});

test("streaming reuses completed history and retains day boundaries and withdrawn numbering", () => {
  const cache = new FeedPrefix();
  const base = input();
  const state = { ...base, turns: [turn("withdrawn", 1), turn("a", 2), turn("b", 3, "running")] };
  state.turns[0] = create(ui.TurnSchema, { ...state.turns[0], withdrawn: true });
  const first = cache.build(state, build);
  const delta = { ...state, entries: [state.entries[0]!, entry("live", "b", 2n)] };
  const visited: number[] = [];

  const after = cache.build(delta, (part, context) => {
    visited.push(part.turns.length);

    return build(part, context);
  });

  expect(visited).toEqual([1]);
  expect(after).toEqual(build(delta));
  expect(after[0]).toBe(first[0]);
  const nextDay = { ...delta, turns: [...delta.turns.slice(0, -1), turn("b", 3, "running", 2)] };
  expect(cache.build(nextDay, build)).toEqual(build(nextDay));
});

test("history edits, late results, notices, prepends and fold preferences invalidate the prefix", () => {
  const cache = new FeedPrefix();
  let state = input();
  cache.build(state, build);

  const variants: FeedInput[] = [
    { ...state, entries: [entry("old", "a", 1n), state.entries[1]!] },
    { ...state, results: new Map([["a", { usage: undefined, reason: "late result" }]]) },
    { ...state, notices: [{ seq: 3n, turnId: "a", at: undefined, notice: create(NoticeSchema) }] },
    { ...state, turns: [turn("older", 0), ...state.turns], entries: [entry("older", "older", 0n), ...state.entries] },
    { ...state, openWork: new Set(["a"]) },
  ];

  for (const variant of variants) {
    expect(cache.build(variant, build)).toEqual(build(variant));
    state = variant;
  }
});

test("interleaved, nested and background work across the boundary stays on the full path", () => {
  const base = input();
  const background = entry("task", "b", 3n);

  const cases = [
    { ...base, entries: [base.entries[1]!, base.entries[0]!] },
    { ...base, entries: [base.entries[0]!, entry("nested", "b", 3n, "old")] },
    {
      ...base,
      entries: [
        ...base.entries,
        {
          ...background,
          item: create(ItemSchema, {
            ...background.item,
            content: { case: "backgroundTask", value: { sourceItemId: "old" } },
          }),
        },
      ],
    },
    {
      ...base,
      entries: [
        { ...base.entries[0]!, item: create(ItemSchema, { ...base.entries[0]!.item, status: ItemStatus.IN_PROGRESS }) },
        base.entries[1]!,
      ],
    },
    { ...base, entries: [base.entries[0]!, entry("late", "b", 0n)] },
  ];

  for (const state of cases) {
    const visited: number[] = [];

    const actual = new FeedPrefix().build(state, (part, context) => {
      visited.push(part.turns.length);

      return build(part, context);
    });

    expect(visited).toEqual([2]);
    expect(actual).toEqual(build(state));
  }
});

test("feed reconciliation retains untouched rows across deltas and reordered history", () => {
  const builder = new FeedBuilder();
  const state = input();
  const first = builder.build(state);
  const delta = { ...state, entries: [state.entries[0]!, entry("live", "b", 2n)] };
  const next = builder.build(delta);
  expect(next).toEqual(new FeedBuilder().build(delta));

  for (const row of first.filter((row) => !row.key.includes("b") && !row.key.includes("live")))
    expect(next.find((candidate) => candidate.key === row.key)).toBe(row);

  for (const variant of [
    { ...delta, openWork: new Set(["a", "b"]) },
    { ...delta, turns: [turn("older", 0), ...delta.turns], entries: [entry("older", "older", 0n), ...delta.entries] },
    { ...delta, turns: [turn("b", 1, "running"), turn("a", 2)] },
    { ...delta, entries: [], turns: [] },
    state,
  ])
    expect(builder.build(variant)).toEqual(new FeedBuilder().build(variant));
});
