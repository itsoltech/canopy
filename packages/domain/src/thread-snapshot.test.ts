import { expect, test } from "bun:test";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
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

test("decoded control refreshes keep idle checkpoints and replace changed or removed controls", () => {
  const applyControls = (state: ui.ThreadSnapshot, value: MessageInitShape<typeof ui.ThreadControlsSchema>) => {
    const update = create(ui.ThreadUpdateSchema, { change: { case: "controls", value } });

    return applyThreadUpdate(state, fromBinary(ui.ThreadUpdateSchema, toBinary(ui.ThreadUpdateSchema, update)));
  };

  const empty = create(ui.ThreadSnapshotSchema, { cursor: "checkpoint", items: [item("saved")] });
  expect(applyControls(empty, {})).toBe(empty);

  const secret = { requestId: "request", status: "pending" };
  const schedules = [{ id: "first" }, { id: "second" }];
  const active = applyControls(empty, { secrets: [secret], schedules });
  expect(applyControls(active, { secrets: [secret], schedules })).toBe(active);

  // Field 100 is a varint a newer gateway may send before this client knows its descriptor.
  const wire = toBinary(ui.ThreadSecretSchema, create(ui.ThreadSecretSchema, secret));
  const extended = fromBinary(ui.ThreadSecretSchema, new Uint8Array([...wire, 0xa0, 0x06, 0x01]));
  const newer = applyControls(active, { secrets: [extended], schedules });
  expect(newer).not.toBe(active);
  expect(applyControls(newer, { secrets: [extended], schedules })).toBe(newer);

  const saved = applyControls(active, { secrets: [{ ...secret, status: "saved" }], schedules });
  expect(saved.secrets[0]?.status).toBe("saved");
  expect(saved.schedules).toBe(active.schedules);

  const reordered = applyControls(saved, { secrets: saved.secrets, schedules: [...schedules].reverse() });
  expect(reordered.secrets).toBe(saved.secrets);
  expect(reordered.schedules.map((schedule) => schedule.id)).toEqual(["second", "first"]);

  const cleared = applyControls(reordered, {});
  expect(cleared.secrets).toEqual([]);
  expect(cleared.schedules).toEqual([]);
  expect(cleared.items).toBe(empty.items);
  expect(cleared.cursor).toBe(empty.cursor);
  expect(applyControls(cleared, {})).toBe(cleared);
});

test("header-only sequence batches advance a validated checkpoint and preserve the loaded history window", () => {
  const base = create(ui.ThreadSnapshotSchema, {
    thread: { id: "thread", title: "Before", lastSeq: 8n },
    lastSeq: 8n,
    syncCursor: { threadId: "thread", epoch: "epoch", appliedSeq: 2n },
    cursor: "range:epoch:2",
    turns: [{ id: "turn", ordinal: 10 }],
    items: [item("saved")],
    historyHasMore: true,
    historyBeforeTurnId: "turn",
  });

  const header = create(ui.ThreadSyncRecordSchema, {
    seq: 3n,
    key: "thread:thread",
    value: { case: "thread", value: { id: "thread", title: "Renamed", lastSeq: 9n } },
  });

  const batch = create(ui.ThreadSyncBatchSchema, {
    threadId: "thread",
    epoch: "epoch",
    baseSeq: 2n,
    appliedSeq: 3n,
    headSeq: 3n,
    caughtUp: true,
    records: [header],
  });

  const apply = (state: ui.ThreadSnapshot, value: ui.ThreadSyncBatch) =>
    applyThreadUpdate(state, create(ui.ThreadUpdateSchema, { change: { case: "batch", value } }));

  const next = apply(base, batch);
  expect(next.thread?.title).toBe("Renamed");
  expect(next.lastSeq).toBe(9n);
  expect(next.cursor).toBe("range:epoch:3");
  expect(next.syncCursor?.appliedSeq).toBe(3n);
  expect(next.items).toBe(base.items);
  expect(next.turns).toBe(base.turns);
  expect(next.historyBeforeTurnId).toBe("turn");
  expect(apply(next, batch)).toBe(next);
  expect(() => apply(base, { ...batch, epoch: "other" })).toThrow("identity");
  expect(() => apply(base, { ...batch, records: [{ ...header, seq: 4n }] })).toThrow("incomplete");

  const mixed = apply(base, {
    ...batch,
    headSeq: 4n,
    appliedSeq: 4n,
    records: [create(ui.ThreadSyncRecordSchema, { seq: 3n, key: "item:saved", removed: true }), { ...header, seq: 4n }],
  });

  expect(mixed.thread?.title).toBe("Renamed");
  expect(mixed.items).toEqual([]);
  expect(mixed.cursor).toBe("range:epoch:4");
});

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
