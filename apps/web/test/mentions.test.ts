import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema } from "@open-agents/contracts";
import { activeTrigger, serialize, toHtml, trimValue, withoutPlatformNote, type EditorNode, type TriggerChar } from "../src/lib/features/mentions/editor.ts";
import { mentionsFromWire, mentionsToWire } from "../src/lib/features/mentions/wire.ts";

/** Plain objects shaped like the DOM nodes the editor holds. */
const text = (data: string): EditorNode => ({ nodeType: 3, nodeName: "#text", textContent: data, childNodes: [] });
const br = (): EditorNode => ({ nodeType: 1, nodeName: "BR", textContent: "", childNodes: [] });
const div = (...children: EditorNode[]): EditorNode => ({ nodeType: 1, nodeName: "DIV", textContent: null, childNodes: children });
const chip = (mention: object): EditorNode => ({ nodeType: 1, nodeName: "SPAN", textContent: "Label", childNodes: [text("Label")], dataset: { element: "mention", mention: JSON.stringify(mention) } });
const root = (...children: EditorNode[]): EditorNode => ({ nodeType: 1, nodeName: "DIV", textContent: null, childNodes: children });

const ALL = new Set<TriggerChar>(["/", "$", "@", "#"]);

describe("editor model", () => {
  test("chips become placeholders with ranges; line breaks and the browser's last <br>", () => {
    const value = serialize(
      root(
        text("To jest skill: "),
        chip({ kind: MentionKind.SKILL, name: "transitions-dev", label: "Transitions Dev", icon: "data:image/png;base64,xx" }),
        text(" plik: "),
        chip({ kind: MentionKind.FILE, name: "docs/notatka-z-lekcji.md" }),
        br(),
        text("czat "),
        chip({ kind: MentionKind.THREAD, name: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", label: "Uwzględnij 3 zadania Pauli" }),
        br(),
        br(),
      ),
    );
    expect(value.text).toBe("To jest skill: $transitions-dev plik: @docs/notatka-z-lekcji.md\nczat #Uwzględnij 3 zadania Pauli\n");
    expect(value.mentions.map((m) => value.text.slice(m.start, m.end))).toEqual(["$transitions-dev", "@docs/notatka-z-lekcji.md", "#Uwzględnij 3 zadania Pauli"]);
    // The icon is the composer's, not part of the message.
    expect(Object.keys(value.mentions[0]!)).not.toContain("icon");
  });

  test("lines a browser wrapped in blocks", () => {
    expect(serialize(root(text("a"), div(text("b")), div(br()))).text).toBe("a\nb\n");
  });

  test("toHtml renders the same value back (text escaped, chips non-editable)", () => {
    const m = create(MentionSchema, { kind: MentionKind.COMMAND, name: "review", start: 4, end: 11 });
    const html = toHtml({ text: "<b> /review\n", mentions: [m] });
    expect(html.startsWith("&lt;b&gt; ")).toBe(true);
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain("data-mention=");
    expect(html.endsWith("<br><br>")).toBe(true);
  });

  test("triggers at a line start or after a space, with what was typed", () => {
    expect(activeTrigger("hello /rev", ALL)).toEqual({ char: "/", query: "rev", length: 4 });
    expect(activeTrigger("$", ALL)).toEqual({ char: "$", query: "", length: 1 });
    expect(activeTrigger("see @src/ma", ALL)).toEqual({ char: "@", query: "src/ma", length: 7 });
    expect(activeTrigger("and #plan sprintu", ALL)).toEqual({ char: "#", query: "plan sprintu", length: 13 });
    expect(activeTrigger("a/b", ALL)).toBeUndefined(); // a path, not a command
    expect(activeTrigger("mail@example", ALL)).toBeUndefined();
    expect(activeTrigger("costs $5 ", ALL)).toBeUndefined(); // a space ends it
    expect(activeTrigger("x /y", new Set<TriggerChar>(["@"]))).toBeUndefined();
  });

  test("trimming keeps the ranges on their placeholders", () => {
    const value = trimValue({ text: "  $s go \n", mentions: [create(MentionSchema, { kind: MentionKind.SKILL, name: "s", start: 2, end: 4 })] });
    expect(value.text).toBe("$s go");
    expect(value.mentions.map((m) => value.text.slice(m.start, m.end))).toEqual(["$s"]);
  });

  test("a transcript message loses the platform note, the chips stay", () => {
    const full = "[open-agents] The user mentioned another thread…:\n- \"T\" (thread_id: x)\n\nsee #T";
    const start = full.indexOf("#T");
    const value = withoutPlatformNote({ text: full, mentions: [create(MentionSchema, { kind: MentionKind.THREAD, name: "x", label: "T", start, end: start + 2 })] });
    expect(value.text).toBe("see #T");
    expect(value.mentions[0]).toMatchObject({ start: 4, end: 6 });
  });

  test("the wire form round-trips and refuses junk", () => {
    const m = [create(MentionSchema, { kind: MentionKind.FILE, name: "a.md", start: 0, end: 5, isDir: false })];
    expect(mentionsFromWire(JSON.stringify(mentionsToWire(m)))).toEqual(m);
    expect(mentionsFromWire(null)).toEqual([]);
    expect(() => mentionsFromWire([{ kind: "NOPE" }])).toThrow();
    expect(() => mentionsFromWire("{}")).toThrow();
  });
});

describe("editor model: block shapes", () => {
  test.each([
    [[div(text("a")), div(text("b"))], "a\nb"],
    [[div(text("a")), div(br())], "a\n"],
    [[div(br()), div(br())], "\n"],
    [[div(text("a")), text("b")], "a\nb"],
  ])("%#", (children, expected) => {
    expect(serialize(root(...children)).text).toBe(expected);
  });
});

test("readable text uses the chips' labels", async () => {
  const { readableText } = await import("../src/lib/features/mentions/editor.ts");
  const value = { text: "Use $transitions-dev on @docs/a.md", mentions: [create(MentionSchema, { kind: MentionKind.SKILL, name: "transitions-dev", label: "Transitions Dev", start: 4, end: 20 }), create(MentionSchema, { kind: MentionKind.FILE, name: "docs/a.md", start: 24, end: 34 })] };
  expect(readableText(value)).toBe("Use Transitions Dev on a.md");
});
