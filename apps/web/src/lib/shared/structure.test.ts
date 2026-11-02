import { describe, expect, test } from "bun:test";
import { isEmptyNode, structure, structureJson } from "./structure.ts";

describe("structure", () => {
  test("objects become labelled fields in their order", () => {
    const node = structure({ thread_id: "01a198ce-fe6b-757d-a524-4dd87fb54c63", limit: 10, view: "messages" });
    expect(node.kind).toBe("object");
    if (node.kind !== "object") return;
    expect(node.fields.map((f) => f.label)).toEqual(["Thread ID", "Limit", "View"]);
    expect(node.fields[0]!.node).toEqual({ kind: "id", id: "01a198ce-fe6b-757d-a524-4dd87fb54c63" });
    expect(node.fields[1]!.node).toEqual({ kind: "number", text: "10" });
    expect(node.fields[2]!.node).toEqual({ kind: "text", text: "messages" });
  });

  test("enum tokens in words, raw kept", () => {
    expect(structure("full_auto")).toEqual({ kind: "enum", label: "Full auto", raw: "full_auto" });
    expect(structure("ITEM_STATUS_COMPLETED")).toEqual({ kind: "enum", label: "Completed", raw: "ITEM_STATUS_COMPLETED" });
  });

  test("dates, links, paths and long text", () => {
    expect(structure("2026-11-01T18:21:00.781Z").kind).toBe("date");
    expect(structure("https://example.com/a?b=c").kind).toBe("url");
    expect(structure("/tmp/oa-stack/code/goal-check.txt").kind).toBe("path");
    expect(structure("src/lib/format.ts").kind).toBe("path");
    expect(structure("line one\nline two").kind).toBe("long");
    expect(structure("x".repeat(200)).kind).toBe("long");
    expect(structure("Run ls -A and report").kind).toBe("text");
  });

  test("ids judged by their key and by their shape", () => {
    expect(structure("toolu_01FoEfXKGNKxkUhjKeTgi13K").kind).toBe("id");
    expect(structure("abc12345", "request_id").kind).toBe("id");
    expect(structure("abc", "request_id").kind).toBe("text");
    const list = structure(["01a198ce-fe6b-757d-a524-4dd87fb54c63"], "thread_ids");
    expect(list.kind === "list" && list.items[0]!.kind).toBe("id");
  });

  test("JSON inside a string is structured", () => {
    const node = structure('{"answer":"yes"}', "answer_json");
    expect(node.kind).toBe("object");
  });

  test("empties", () => {
    expect(isEmptyNode(structure(null))).toBe(true);
    expect(isEmptyNode(structure(""))).toBe(true);
    expect(isEmptyNode(structure({}))).toBe(true);
    expect(isEmptyNode(structure([]))).toBe(true);
    expect(structure(false)).toEqual({ kind: "bool", value: false });
  });

  test("deep nesting stops as one JSON line", () => {
    let value: unknown = { leaf: 1 };
    for (let i = 0; i < 10; i++) value = { next: value };
    let node = structure(value);
    let depth = 0;
    while (node.kind === "object") {
      node = node.fields[0]!.node;
      depth++;
    }
    expect(node.kind).toBe("long");
    expect(depth).toBeLessThan(10);
  });
});

describe("structureJson", () => {
  test("JSON text and plain text", () => {
    expect(structureJson('{"a":1}').kind).toBe("object");
    expect(structureJson("plain").kind).toBe("text");
    expect(structureJson("a\nb").kind).toBe("long");
    expect(structureJson("").kind).toBe("empty");
  });
});
