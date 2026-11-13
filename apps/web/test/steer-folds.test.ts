import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ItemStatus, ui, type Item } from "@canopy/contracts";
import { workFoldOpen } from "@canopy/domain/work-fold";
import { segmentsOf, turnBody } from "../../mobile/src/features/timeline/turn-plan.ts";
import { FeedBuilder, type FeedInput, type FeedRow } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-types.ts";
import { planFolds, readWork } from "../src/lib/features/threads/work-segments.ts";

const turn = create(ui.TurnSchema, {
  id: "turn",
  status: "running",
  inputText: "Start",
  startedAt: timestampFromMs(0),
});

const preferences = { expandWhileWorking: true, keepAfterTurn: false };

function entries(kinds: readonly string[]): TimelineEntry[] {
  return kinds.map((kind, at) => {
    const id = `${kind}-${at}`;
    const content: Item["content"] = { case: "reasoning", value: { text: "Thinking" } };

    return {
      id,
      turnId: turn.id,
      firstSeq: BigInt(at + 1),
      inherited: false,
      fromThreadId: "",
      ...(kind === "final" && { completedAt: (at + 1) * 1000 }),
      item: create(ItemSchema, {
        itemId: id,
        status: ItemStatus.COMPLETED,
        content:
          kind === "steer" || kind === "platform"
            ? { case: "userMessage", value: { text: id, clientId: id } }
            : kind === "final" || kind === "message"
              ? { case: "agentMessage", value: { text: id, phase: kind === "final" ? "final_answer" : "" } }
              : content,
      }),
    };
  });
}

function input(items: readonly TimelineEntry[], status = "running", openWork = new Set<string>()): FeedInput {
  return {
    entries: items,
    turns: [{ ...turn, status }],
    notices: [],
    results: new Map(),
    steering: [],
    working: status === "running",
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork,
  };
}

const itemKeys = (rows: readonly FeedRow[]) =>
  rows.flatMap((row) =>
    row.kind === "timeline" && row.row.kind === "item"
      ? [row.row.key]
      : row.kind === "answer" && row.row
        ? [row.row.key]
        : [],
  );

describe("steered input outside work", () => {
  const cases = [
    ["steer", "work", "final"],
    ["work", "steer", "work"],
    ["work", "message", "steer"],
    ["work", "steer", "work", "steer", "work", "final"],
    ["steer", "steer", "work", "steer", "steer"],
    ["work", "final", "steer", "work", "steer", "final"],
  ];

  test("start, middle, end and repeated steers keep their chronological rows with any fold collapsed", () => {
    for (const kinds of cases) {
      const items = entries(kinds);

      for (const status of ["running", "completed", "interrupted"]) {
        const plan = planFolds([{ ...turn, status }], items, []);

        for (let mask = 0; mask < 2 ** plan.folds.length; mask++) {
          const open = new Set(plan.folds.filter((_, index) => mask & (1 << index)).map((fold) => fold.id));
          const rows = new FeedBuilder().build(input(items, status, open));
          const shown = rows.filter((row) => row.kind === "timeline" && row.row.kind === "item" && row.row.steer);
          expect(shown.map((row) => row.key)).toEqual(
            items.filter((_, at) => kinds[at] === "steer").map((e) => `item:${e.id}`),
          );
          expect(shown.every((row) => row.kind === "timeline" && !row.work)).toBe(true);
          expect(shown.every((row) => !plan.workOf.has(row.key))).toBe(true);
        }

        const all = new Set(plan.folds.map((fold) => fold.id));
        expect(itemKeys(new FeedBuilder().build(input(items, status, all)))).toEqual(items.map((e) => `item:${e.id}`));
      }
    }
  });

  test("a steer preserves earlier choices and reading anchors; the final answer closes all preceding work", () => {
    const items = entries(["work", "steer", "work", "final"]);
    const before = planFolds([turn], items.slice(0, 1), []).folds[0]!;
    const split = planFolds([turn], items.slice(0, 3), []);
    expect(split.folds.map((fold) => workFoldOpen(fold, preferences))).toEqual([true, true]);
    expect(workFoldOpen(split.folds[0]!, preferences, { open: false, state: before })).toBe(false);
    expect(readWork(["turn"], ["item:work-0"], split.workOf)).toEqual(new Map([["turn", "item:work-0"]]));
    const final = planFolds([turn], items, []);
    expect(final.folds.map((fold) => fold.answerSeq)).toEqual([4n, 4n]);
    expect(final.folds.map((fold) => workFoldOpen(fold, preferences, { open: true, state: before }))).toEqual([
      false,
      false,
    ]);

    const ended = planFolds([{ ...turn, status: "completed" }], items, []);

    const late = planFolds(
      [{ ...turn, status: "completed" }],
      [...items, ...entries(["work"]).map((e) => ({ ...e, id: "late", firstSeq: 9n }))],
      [],
    );

    expect(ended.folds.map((fold) => workFoldOpen(fold, preferences))).toEqual([false, false]);
    expect(workFoldOpen(late.folds[0]!, preferences, { open: true, state: ended.folds[0]! })).toBe(true);
  });

  test("incremental catch-up, reordered snapshots and virtual remounts derive the same feed", () => {
    const items = entries(["work", "steer", "work", "steer", "final"]);
    const builder = new FeedBuilder();
    const initial = builder.build(input(items.slice(0, 1), "running", new Set(["turn"])));
    const workKey = initial.find((row) => row.kind === "work")!.key;

    for (let count = 2; count <= items.length; count++) {
      const state = input(items.slice(0, count));
      expect(builder.build(state)).toEqual(
        new FeedBuilder().build({ ...state, entries: [...state.entries].reverse() }),
      );
      expect(builder.build(state).some((row) => row.key === workKey)).toBe(true);
    }

    const state = input(items, "completed");
    expect(builder.build(state)).toEqual(new FeedBuilder().build(state));
    expect(itemKeys(builder.build(state))).toEqual(["item:steer-1", "item:steer-3", "item:final-4"]);

    // The same completed turn in a fork's visible history uses the same segmentation.
    const history = new FeedBuilder().build({
      ...input([]),
      turns: [],
      inheritedEntries: items,
      inheritedTurns: state.turns,
      forkSourceId: "source",
      historyOpen: true,
    });

    expect(
      history
        .filter((row) => row.kind === "timeline" && row.row.kind === "item" && row.row.steer)
        .map((row) => row.work),
    ).toEqual([false, false]);
  });

  test("mobile derives the same inputs, work, answer boundaries and collapse choices from persisted items", () => {
    for (const kinds of cases) {
      const items = entries(kinds);

      const mobile = items.map((e) =>
        create(ui.TimelineItemSchema, { item: e.item, turnId: e.turnId, firstSeq: e.firstSeq }),
      );

      for (const status of ["running", "completed", "failed"]) {
        const current = { ...turn, status };
        const body = turnBody(current, mobile, []);
        const segments = segmentsOf(current, body, () => false);
        const web = planFolds([current], items, []);
        expect(
          segments.map((segment) => ({
            live: segment.live,
            answered: segment.answered,
            answerSeq: body[segment.answerBoundary]?.seq,
          })),
        ).toEqual(web.folds.map(({ live, answered, answerSeq }) => ({ live, answered, answerSeq })));

        const visible = segments.flatMap((segment) => [
          ...body.slice(segment.start, segment.start + segment.inputs).map((row) => row.key),
          ...(segment.answer >= 0 ? [body[segment.answer]!.key] : []),
        ]);

        expect(visible).toEqual(itemKeys(new FeedBuilder().build(input(items, status))));
      }
    }
  });

  test("platform steers also stay outside folds, retaining the notice renderer's item identity", () => {
    const items = entries(["work", "platform", "work", "final"]);
    const state = input(items, "completed");
    const rows = new FeedBuilder().build(state);
    const notice = rows.find((row) => row.key === "item:platform-1");
    expect(notice).toMatchObject({ kind: "timeline", work: false, row: { steer: true, node: { entry: items[1] } } });
    expect(planFolds(state.turns, items, []).workOf.has("item:platform-1")).toBe(false);
  });
});
