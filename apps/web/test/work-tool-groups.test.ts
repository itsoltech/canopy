import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, ui } from "@canopy/contracts";
import { WorkGroupChoices } from "@canopy/domain/work-group-choices";
import { turnBody, workRows } from "../../mobile/src/features/timeline/turn-plan.ts";
import { FeedBuilder, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-types.ts";

test("tool-group choices outlive rows, streaming, preference changes and turn completion", () => {
  const choices = new WorkGroupChoices();
  expect(choices.open("first", true, false)).toBe(false);
  choices.choose("first", true);
  // The same timeline memory is used by replacement virtual cells and later streaming rows.
  expect(choices.open("first", true, false)).toBe(true);
  expect(choices.open("second", true, false)).toBe(false);
  expect(choices.open("second", true, true)).toBe(true);
  choices.choose("second", false);
  expect(choices.open("second", true, true)).toBe(false);
  expect(choices.open("first", false, false)).toBe(true);
  expect(choices.open("second", false, true)).toBe(false);
});

test("automatic groups follow the live preference and retain their last state after completion", () => {
  const choices = new WorkGroupChoices();
  expect(choices.open("group", true, true)).toBe(true);
  expect(choices.open("group", true, false)).toBe(false);
  expect(choices.open("group", true, true)).toBe(true);
  expect(choices.open("group", false, false)).toBe(true);
  expect(choices.open("unseen-history", false, true)).toBe(false);
  expect(new WorkGroupChoices().open("group", true, false)).toBe(false);
});

const turn = create(ui.TurnSchema, { id: "turn", status: "running", inputText: "Start" });

function entry(id: string, seq: bigint, commentary = false): TimelineEntry {
  return {
    id,
    turnId: turn.id,
    firstSeq: seq,
    inherited: false,
    fromThreadId: "",
    item: create(ItemSchema, {
      itemId: id,
      status: ItemStatus.IN_PROGRESS,
      content: commentary
        ? { case: "agentMessage", value: { text: "Checking the next step.", phase: "commentary" } }
        : { case: "commandExecution", value: { command: "bun test --filter work" } },
    }),
  };
}

function input(entries: readonly TimelineEntry[], openGroups = new Set<string>()): FeedInput {
  return {
    entries,
    turns: [turn],
    notices: [],
    results: new Map(),
    steering: [],
    working: true,
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set([turn.id]),
    openGroups,
  };
}

test("web and mobile retain a sole collapsed group header and live progress as a second group arrives", () => {
  const first = entry("first", 1n);
  const entries = [first, entry("commentary", 2n, true), entry("second", 3n)];
  const builder = new FeedBuilder();
  const sole = builder.build(input([first]));
  const group = sole.find((row) => row.kind === "work-group");
  expect(group).toMatchObject({
    open: false,
    running: true,
    status: ItemStatus.IN_PROGRESS,
    statusCount: 1,
    hint: "Running bun test --filter work…",
    items: ["item:first"],
  });
  const key = group!.key;
  const multiple = builder.build(input(entries));
  expect(multiple.filter((row) => row.kind === "work-group").map((row) => row.key)).toEqual([
    key,
    "group:turn:item:second",
  ]);
  expect(multiple.some((row) => row.kind === "timeline" && row.key === "item:first")).toBe(false);
  expect(multiple.some((row) => row.kind === "timeline" && row.key === "item:commentary")).toBe(true);
  const expanded = builder.build(input(entries, new Set([key])));
  expect(expanded.find((row) => row.key === "item:first")).toMatchObject({ group: "end" });

  expect(expanded.find((row) => row.key === "group:turn:item:second")).toMatchObject({ open: false });

  const mobile = (items: readonly TimelineEntry[]) =>
    workRows(
      turnBody(
        turn,
        items.map((item) => create(ui.TimelineItemSchema, { item: item.item, firstSeq: item.firstSeq })),
        [],
      ),
    );

  const mobileSole = mobile([first]);
  expect(mobileSole[0]).toMatchObject({
    kind: "group",
    key: "item:first",
    running: true,
    statusCount: 1,
    hint: "Running bun test --filter work…",
  });
  const mobileMultiple = mobile(entries);
  expect(mobileMultiple.map((row) => row.kind)).toEqual(["group", "row", "group"]);
  expect(mobileMultiple[0]).toEqual(mobileSole[0]);
});
