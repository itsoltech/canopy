import { expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { retainTree, threadForest, treeOf } from "../src/lib/features/threads/thread-tree.ts";

const thread = (id: string, at: number, patch: MessageInitShape<typeof ui.ThreadSchema> = {}) =>
  create(ui.ThreadSchema, { id, title: id, createdAt: timestampFromMs(at), ...patch });

test("treeOf finds the same tree as the whole forest, and a rebuilt equal tree keeps its value", () => {
  const threads = [
    thread("main", 3),
    thread("late-side", 9, { kind: ui.ThreadKind.SIDE, parentThreadId: "main" }),
    thread("early-side", 5, { kind: ui.ThreadKind.SIDE, parentThreadId: "main" }),
    thread("other", 1),
    thread("orphan", 2, { kind: ui.ThreadKind.SIDE, parentThreadId: "missing" }),
    thread("nested", 4, { kind: ui.ThreadKind.SIDE, parentThreadId: "late-side" }),
  ];

  for (const current of threads) {
    const rootId = current.kind === ui.ThreadKind.SIDE && current.parentThreadId ? current.parentThreadId : current.id;
    const expected = threadForest(threads).find((tree) => tree.main.id === rootId) ?? { main: current, sides: [] };
    expect(treeOf(threads, current)).toEqual(expected);
  }

  const keep = retainTree();
  const first = keep(treeOf(threads, threads[0]!));
  expect(keep(treeOf([...threads], threads[0]!))).toBe(first);
  const renamed = threads.with(1, create(ui.ThreadSchema, { ...threads[1]!, title: "Renamed" }));
  expect(keep(treeOf(renamed, threads[0]!))).not.toBe(first);
});
