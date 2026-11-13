import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, ui } from "@canopy/contracts";
import { FeedBuilder, type FeedInput } from "../src/lib/features/threads/feed.ts";
import type { TimelineEntry } from "../src/lib/features/threads/thread-types.ts";

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
    content:
      id === "command"
        ? { case: "commandExecution", value: { command: "pwd" } }
        : id === "steer"
          ? { case: "userMessage", value: { text: "Message from a subagent", clientId: "steer" } }
          : { case: "agentMessage", value: { text: `${turnId} answer`, phase: "final_answer" } },
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
