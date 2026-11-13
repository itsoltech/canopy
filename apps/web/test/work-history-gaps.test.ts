import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Match } from "effect";
import { ItemSchema, ItemStatus, ui } from "@canopy/contracts";
import { FeedBuilder, feedScrollKey, resolveFeedScrollKey, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-types.ts";
import { prefetchWorkHistory, recoverFoldRows } from "../src/lib/features/threads/work-history.ts";
import { buildTimeline } from "../src/lib/features/threads/timeline.ts";

const turns = ["earlier", "latest"].map((id, ordinal) =>
  create(ui.TurnSchema, { id, ordinal, status: "completed", inputText: id }),
);

const entries: TimelineEntry[] = [
  ["command", "earlier"],
  ["steer", "earlier"],
  ["answer", "earlier"],
  ["answer", "latest"],
].map(([id = "", turnId = ""], index) => ({
  id,
  turnId,
  firstSeq: BigInt(index + 1),
  inherited: false,
  fromThreadId: "",
  item: create(ItemSchema, {
    itemId: `${turnId}-${id}`,
    status: ItemStatus.COMPLETED,
    content: Match.value(id).pipe(
      Match.when("command", () => ({ case: "commandExecution" as const, value: { command: "pwd" } })),
      Match.when("steer", () => ({
        case: "userMessage" as const,
        value: { text: "Message from a subagent", clientId: "steer" },
      })),
      Match.orElse(() => ({
        case: "agentMessage" as const,
        value: { text: `${turnId} answer`, phase: "final_answer" },
      })),
    ),
  }),
}));

function input(items: readonly TimelineEntry[], historyItemsHasMore: boolean): FeedInput {
  return {
    entries: items,
    turns,
    notices: [],
    results: new Map(),
    steering: [],
    working: false,
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set(),
    historyItemsHasMore,
  };
}

test("bounded and persisted tails show a fetchable gap instead of an empty completed work fold", () => {
  const rows = new FeedBuilder().build(input(entries.slice(-1), true));
  expect(rows.some((row) => row.key === "work-gap:earlier")).toBe(true);
  expect(rows.some((row) => row.key === "work:earlier")).toBe(false);
  expect(rows.some((row) => row.key === "answer:earlier")).toBe(false);
  expect(rows.find((row) => row.key === "answer:latest")).toMatchObject({ row: { node: { entry: entries[3] } } });
});

test("paging replaces the gap with steer segments, collapsed summaries and the original answer", () => {
  const builder = new FeedBuilder();
  builder.build(input(entries.slice(-1), true));
  const restored = builder.build(input(entries, false));
  expect(restored.some((row) => row.key.startsWith("work-gap:"))).toBe(false);
  expect(restored.find((row) => row.key === "work:earlier")).toMatchObject({
    summary: { size: 1, counts: "1 command" },
  });
  expect(restored.find((row) => row.key === "item:steer")).toMatchObject({ work: false });
  expect(restored.find((row) => row.key === "answer:earlier/1")).toMatchObject({
    row: { node: { entry: entries[2] } },
  });
  expect(restored).toEqual(new FeedBuilder().build(input(entries, false)));
});

test("rewound work gaps stay hidden until Show and paging restores the same segments as ordinary history", () => {
  const builder = new FeedBuilder();

  const rewound = turns.map((turn) =>
    turn.id === "earlier" ? { ...turn, rewindId: "rewind", trigger: "user" } : turn,
  );

  const partial = { ...input(entries.slice(-1), true), turns: rewound };
  const hidden = builder.build(partial);
  expect(hidden.find((row) => row.kind === "rewind")).toMatchObject({ messages: 1, open: false });
  expect(hidden.some((row) => row.key === "work-gap:earlier")).toBe(false);
  const openRewinds = new Set(["rewind"]);
  const shown = builder.build({ ...partial, openRewinds });
  const gap = shown.findIndex((row) => row.key === "work-gap:earlier");
  expect(gap).toBeGreaterThan(-1);
  expect(prefetchWorkHistory(shown, gap, gap + 1)).toBe(true);

  const complete = { ...input(entries, false), turns: rewound, openRewinds };
  const restored = builder.build(complete);
  expect(restored.some((row) => row.kind === "work-gap")).toBe(false);
  expect(restored.find((row) => row.key === "work:earlier")).toMatchObject({ summary: { size: 1 } });
  expect(restored.filter((row) => row.kind !== "rewind").map((row) => row.key)).toEqual(
    new FeedBuilder().build(input(entries, false)).map((row) => row.key),
  );
  expect(builder.build({ ...complete, openRewinds: new Set() }).some((row) => row.key === "work:earlier")).toBe(false);
});

test("paging older steers keeps the reading anchor on its message when segment slots are reassigned", () => {
  for (const inherited of [false, true]) {
    const state = (items: readonly TimelineEntry[], more: boolean): FeedInput => {
      const base = input(items, more);

      return inherited
        ? {
            ...base,
            entries: [],
            turns: [],
            inheritedEntries: items,
            inheritedTurns: turns,
            forkSourceId: "source",
            historyOpen: true,
          }
        : base;
    };

    const builder = new FeedBuilder();
    const partial = builder.build(state(entries.slice(2), true));
    const answer = partial.find((row) => row.kind === "answer" && row.turn.id === "earlier");

    if (!answer) throw new Error("Expected the loaded answer");
    const identity = feedScrollKey(answer);
    const restored = builder.build(state(entries, false));
    const key = resolveFeedScrollKey(restored, identity);
    expect(key).toBe(`${inherited ? "history:source:" : ""}answer:earlier/1`);
    expect(key).not.toBe(answer.key);
    expect(feedScrollKey(restored.find((row) => row.key === key)!)).toBe(identity);
  }
});

test("overscan requests missing turns and a partial segment before they reach the viewport", () => {
  const rows = new FeedBuilder().build(input(entries.slice(-1), true));
  const gap = rows.findIndex((row) => row.key === "work-gap:latest");
  expect(prefetchWorkHistory(rows, gap, gap + 1)).toBe(true);
  expect(prefetchWorkHistory(rows, gap + 1, rows.length)).toBe(false);
  const complete = new FeedBuilder().build(input(entries, false));
  expect(prefetchWorkHistory(complete, 0, complete.length)).toBe(false);
});

test("streaming retains the completed prefix without treating the live tail as another partial turn", () => {
  const builder = new FeedBuilder();
  const state = input(entries, true);
  const first = builder.build(state);
  expect(first.some((row) => row.key === "work-gap:earlier")).toBe(true);
  expect(first.some((row) => row.key === "work-gap:latest")).toBe(false);
  const delta = { ...state, entries: [...entries.slice(0, -1), { ...entries[3]! }] };
  const next = builder.build(delta);
  expect(next).toEqual(new FeedBuilder().build(delta));
  expect(next.find((row) => row.key === "work:earlier")).toBe(first.find((row) => row.key === "work:earlier"));
  expect(builder.build(input(entries.slice(-1), true)).some((row) => row.key === "work:earlier")).toBe(false);
});

test("a fresh running turn and newer empty completed turns do not prefetch all older history", () => {
  const state = input(entries.slice(0, 3), true);

  const newer = [
    { ...turns[1]!, id: "empty", ordinal: 2 },
    { ...turns[1]!, id: "starting", ordinal: 3, status: "running" },
  ];

  const rows = new FeedBuilder().build({ ...state, turns: [turns[0]!, ...newer], working: true });
  expect(rows.filter((row) => row.kind === "work-gap").map((row) => row.turn.id)).toEqual(["earlier"]);
  const start = rows.findIndex((row) => row.key === "input:starting");
  expect(prefetchWorkHistory(rows, start, rows.length)).toBe(false);
});

test("a derivation mismatch exposes every source row instead of trusting an empty fold", () => {
  const body = buildTimeline(entries, turns, [], new Map()).filter((row) => row.kind === "item");
  const reports: number[] = [];
  const recovered = recoverFoldRows(body, [], (count) => reports.push(count));
  expect(reports).toEqual([4]);
  expect(recovered.map((row) => row.kind === "row" && row.row.key)).toEqual(body.map((row) => row.key));
  expect(recovered.every((row) => row.kind === "row" && !row.work)).toBe(true);
});

test("partial inherited history does not freeze empty work in the completed prefix", () => {
  const builder = new FeedBuilder();
  const base = input(entries.slice(-1), true);

  const inherited = {
    ...base,
    entries: [],
    turns: [],
    inheritedEntries: base.entries,
    inheritedTurns: turns,
    forkSourceId: "source",
    historyOpen: true,
  };

  expect(builder.build(inherited).some((row) => row.key === "history:source:work-gap:earlier")).toBe(true);
  expect(
    builder
      .build({ ...inherited, inheritedEntries: entries, historyItemsHasMore: false })
      .some((row) => row.kind === "work-gap"),
  ).toBe(false);
});

test("long paged turns retain steered messages, nested subagent tools and a running subagent with collapsed groups", () => {
  const parent = {
    ...entries[0]!,
    id: "agent",
    item: create(ItemSchema, {
      itemId: "agent",
      status: ItemStatus.IN_PROGRESS,
      content: { case: "subagent", value: { description: "Review the changes", background: true } },
    }),
  };

  const tools = Array.from({ length: 200 }, (_, index): TimelineEntry => ({
    ...entries[0]!,
    id: `nested-${index}`,
    firstSeq: BigInt(index + 3),
    item: create(ItemSchema, {
      ...entries[0]!.item,
      itemId: `nested-${index}`,
      parentItemId: "agent",
    }),
  }));

  const body = [
    entries[0]!,
    parent,
    ...tools,
    ...entries.slice(1).map((entry, index) => ({
      ...entry,
      firstSeq: BigInt(204 + index),
    })),
  ];

  const builder = new FeedBuilder();
  builder.build(input(body.slice(-3), true));
  const restored = builder.build({ ...input(body, false), openWork: new Set(["earlier", "earlier/1"]) });
  const agent = restored.find((row) => row.kind === "work-group" && row.items.includes("item:agent"));
  expect(agent).toMatchObject({ open: false, running: true });
  expect(restored.find((row) => row.key === "item:steer")).toMatchObject({ work: false });
  expect(restored.find((row) => row.key === "answer:earlier/1")).toMatchObject({
    row: { node: { entry: body.at(-2) } },
  });

  const expanded = builder.build({
    ...input(body, false),
    openWork: new Set(["earlier", "earlier/1"]),
    openGroups: new Set([agent!.key]),
  });

  expect(
    expanded.find((row) => row.kind === "timeline" && row.row.kind === "item" && row.row.node.entry.id === "agent"),
  ).toMatchObject({ row: { node: { children: tools.map((entry) => ({ entry, children: [] })) } } });
});
