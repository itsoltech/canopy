import { expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, ThreadEventSchema, ui } from "@canopy/contracts";
import { applyThreadUpdate } from "./thread-snapshot.ts";

type Body = NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>;

const item = (id: string, inherited = false) =>
  create(ui.TimelineItemSchema, {
    inherited,
    fromThreadId: inherited ? "parent" : "",
    turnId: "turn",
    item: {
      itemId: id,
      status: ItemStatus.IN_PROGRESS,
      content: { case: "commandExecution", value: { output: id } },
    },
  });

const event = (seq: bigint, body: Body) =>
  create(ui.ThreadUpdateSchema, {
    change: { case: "event", value: { seq, event: { turnId: "turn", body } } },
  });

const delta = (seq: bigint, itemId: string, chunk: string) =>
  event(seq, { case: "itemDelta", value: { itemId, field: ItemDeltaField.OUTPUT, chunk } });

const start = (seq: bigint, id: string) => event(seq, { case: "itemStarted", value: { item: item(id).item } });

const output = (entry: ui.TimelineItem | undefined) => {
  const content = entry?.item?.content;

  return content?.case === "commandExecution" ? content.value.output : undefined;
};

test("streaming a long history updates only the own item, preserving inherited id collisions", () => {
  const inherited = item("live", true);
  const history = Array.from({ length: 7000 }, (_, index) => item(`history-${index}`));
  const base = create(ui.ThreadSnapshotSchema, { items: [inherited, ...history, item("live")] });
  let current = base;

  for (let seq = 1n; seq <= 200n; seq++) current = applyThreadUpdate(current, delta(seq, "live", "."));

  expect(current.items).toHaveLength(base.items.length);
  expect(current.items.slice(0, -1).every((entry, index) => entry === base.items[index])).toBe(true);
  expect(output(current.items.at(-1))).toBe(`live${".".repeat(200)}`);
  expect(output(base.items.at(-1))).toBe("live");
  expect(output(current.items[0])).toBe("live");
});

test("appends and interleaved threads do not leak indexes into older snapshot branches", () => {
  const base = create(ui.ThreadSnapshotSchema, { items: [item("base")] });
  const left = applyThreadUpdate(base, start(1n, "left"));
  const right = applyThreadUpdate(base, start(1n, "right"));
  const other = create(ui.ThreadSnapshotSchema, { items: [item("left"), item("other")] });
  const updatedLeft = applyThreadUpdate(left, delta(2n, "left", "-left"));
  const updatedOther = applyThreadUpdate(other, delta(1n, "left", "-other"));
  const updatedRight = applyThreadUpdate(right, delta(2n, "right", "-right"));
  const crossed = applyThreadUpdate(updatedRight, start(3n, "left"));

  expect(updatedLeft.items.map(output)).toEqual(["base", "left-left"]);
  expect(updatedRight.items.map(output)).toEqual(["base", "right-right"]);
  expect(updatedOther.items.map(output)).toEqual(["left-other", "other"]);
  expect(crossed.items.map(output)).toEqual(["base", "right-right", "left"]);
  expect(left.items.map(output)).toEqual(["base", "left"]);
  expect(base.items.map(output)).toEqual(["base"]);
});

test("replaced snapshots rebuild item positions after prepend, reorder and deletion", () => {
  const base = create(ui.ThreadSnapshotSchema, { items: [item("a"), item("b")] });
  const warm = applyThreadUpdate(base, delta(1n, "b", "1"));

  const loaded = applyThreadUpdate(
    warm,
    create(ui.ThreadUpdateSchema, {
      change: {
        case: "snapshot",
        value: { items: [item("older"), warm.items[1]!, warm.items[0]!], lastSeq: 1n },
      },
    }),
  );

  const updated = applyThreadUpdate(loaded, delta(2n, "b", "2"));

  const removed = applyThreadUpdate(
    updated,
    create(ui.ThreadUpdateSchema, {
      change: { case: "snapshot", value: { items: [updated.items[1]!], lastSeq: 2n } },
    }),
  );

  expect(updated.items.map(output)).toEqual(["older", "b12", "a"]);
  expect(applyThreadUpdate(removed, delta(3n, "b", "3")).items.map(output)).toEqual(["b123"]);
  expect(applyThreadUpdate(removed, start(3n, "a")).items.map(output)).toEqual(["b12", "a"]);
});

test("projected reconnect deltas invalidate positions before subsequent live events", () => {
  const base = create(ui.ThreadSnapshotSchema, {
    thread: { id: "thread" },
    cursor: "checkpoint",
    items: [item("removed"), item("live")],
  });

  const warm = applyThreadUpdate(base, delta(1n, "live", "1"));

  const resumed = applyThreadUpdate(
    warm,
    create(ui.ThreadUpdateSchema, {
      change: {
        case: "delta",
        value: {
          baseCursor: "checkpoint",
          removedItemIds: ["removed"],
          snapshot: { thread: { id: "thread" }, cursor: "next", lastSeq: 1n },
        },
      },
    }),
  );

  expect(applyThreadUpdate(resumed, delta(2n, "live", "2")).items.map(output)).toEqual(["live12"]);
  expect(applyThreadUpdate(resumed, start(2n, "removed")).items.map(output)).toEqual(["live1", "removed"]);
});

test("unknown and replayed events preserve positions, and own appends never overwrite inherited items", () => {
  const base = create(ui.ThreadSnapshotSchema, { items: [item("same", true)] });
  const unknown = applyThreadUpdate(base, delta(1n, "same", "ignored"));
  const own = applyThreadUpdate(unknown, start(2n, "same"));
  const replay = applyThreadUpdate(own, delta(2n, "same", "ignored"));
  const updated = applyThreadUpdate(replay, delta(3n, "same", "-own"));

  expect(unknown.items).toBe(base.items);
  expect(replay).toBe(own);
  expect(updated.items.map(output)).toEqual(["same", "same-own"]);
  expect(updated.items[0]).toBe(base.items[0]);
});
