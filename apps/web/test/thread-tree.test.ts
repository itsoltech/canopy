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

  const index = new Map(threads.map((entry) => [entry.id, entry]));

  for (const current of threads) {
    const rootId = current.kind === ui.ThreadKind.SIDE && current.parentThreadId ? current.parentThreadId : current.id;
    const expected = threadForest(threads).find((tree) => tree.main.id === rootId) ?? { main: current, sides: [] };
    expect(treeOf(index, current)).toEqual(expected);
  }

  const keep = retainTree();
  const first = keep(treeOf(index, threads[0]!));
  expect(keep(treeOf(new Map(index), threads[0]!))).toBe(first);
  const renamed = create(ui.ThreadSchema, { ...threads[1]!, title: "Renamed" });
  expect(keep(treeOf(new Map(index).set(renamed.id, renamed), threads[0]!))).not.toBe(first);
});

test("a linked subagent and its parent share a tree across projects, including on a direct archived-child URL", () => {
  const main = thread("parent~aaaaaaaaaaaaaaaa", 1, { projectId: "project~aaaaaaaaaaaaaaaa" });

  const child = thread("child", 2, {
    projectId: "scratch",
    parentThreadId: main.id,
    spawnedByAgent: true,
    status: "waiting_input",
  });

  const index = new Map([main, child].map((entry) => [entry.id, entry]));
  expect(treeOf(index, main)).toEqual({ main, sides: [child] });
  const archived = create(ui.ThreadSchema, { ...child, status: "archived" });
  expect(treeOf(index, archived)).toEqual({ main, sides: [archived] });
  index.delete(child.id);
  expect(treeOf(index, archived)).toEqual({ main, sides: [archived] });
});
