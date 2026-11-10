import { expect, test } from "bun:test";
import { FeedRows } from "../src/lib/shared/ui/virtual/feed-rows.ts";
import { SizeIndex } from "../src/lib/shared/ui/virtual/size-index.ts";

test("streamed content keeps structural indexes stable; prepend, removal, reorder and group changes invalidate", () => {
  const structure = new FeedRows();
  const key = (row: { id: string }) => row.id;
  const group = (row: { group: string }) => row.group;

  const rows = [
    { id: "a", group: "message", text: "before" },
    { id: "b", group: "tool", text: "output" },
  ];

  const first = structure.update(rows, key, group);
  const delta = structure.update([{ ...rows[0]!, text: "after" }, rows[1]!], key, group);
  expect(delta).toBe(first);
  const index = new SizeIndex(() => 40);
  index.setRows(first);
  index.measure("a", "message", 80);
  index.setRows(delta);
  expect(index.offset(1)).toBe(80);
  const changed = structure.update([{ ...rows[0]!, group: "tool" }, rows[1]!], key, group);
  expect(changed).not.toBe(first);
  expect(changed[0]!.group).toBe("tool");
  const prepended = structure.update([{ id: "older", group: "message" }, ...rows], key, group);
  index.setRows(prepended);
  expect(index.offset(2)).toBe(160);
  expect(structure.update([...rows].reverse(), key, group).map((row) => row.key)).toEqual(["b", "a"]);
  expect(structure.update([], key, group)).toEqual([]);
});
