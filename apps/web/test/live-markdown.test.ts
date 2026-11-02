import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention } from "@open-agents/contracts";
import { serialize, toHtml, type EditorNode } from "../src/lib/features/mentions/editor.ts";
import { codeSpans, fenceText, findFences, inlineHtml, openingFence } from "../src/lib/features/mentions/markdown.ts";

/**
 * A tiny parser for the HTML the editor renders (tags, attributes, entities), into the node shape `serialize` reads,
 * so the model can be checked both ways: text → toHtml → DOM → serialize → the same text.
 */
function parse(html: string): EditorNode {
  type Node = { nodeType: number; nodeName: string; textContent: string | null; childNodes: Node[]; dataset?: Record<string, string> };
  const root: Node = { nodeType: 1, nodeName: "DIV", textContent: null, childNodes: [] };
  const stack: Node[] = [root];
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  for (const [, close, name, attrs, text] of html.matchAll(/<(\/?)([a-zA-Z]+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!;
    if (text !== undefined) {
      top.childNodes.push({ nodeType: 3, nodeName: "#text", textContent: decode(text), childNodes: [] });
      continue;
    }
    if (close) {
      stack.pop();
      continue;
    }
    const dataset: Record<string, string> = {};
    for (const [, key, value] of (attrs ?? "").matchAll(/data-([a-z-]+)="([^"]*)"/g)) dataset[key!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = decode(value!);
    const node: Node = { nodeType: 1, nodeName: name!.toUpperCase(), textContent: null, childNodes: [], dataset };
    top.childNodes.push(node);
    if (node.nodeName !== "BR" && node.nodeName !== "IMG" && !(attrs ?? "").endsWith("/")) stack.push(node);
  }
  const fill = (node: Node): string => (node.nodeType === 3 ? node.textContent! : (node.textContent = node.childNodes.map(fill).join("")));
  fill(root);
  return root;
}

const roundTrip = (text: string, mentions: Mention[] = []) => serialize(parse(toHtml({ text, mentions })));

describe("live markdown: inline code", () => {
  test("single-backtick spans on one line, the backticks around them", () => {
    const text = "run `npm i` then `bun test`";
    expect(codeSpans(text).map(([s, e]) => text.slice(s, e))).toEqual(["npm i", "bun test"]);
    expect(codeSpans("unclosed `code")).toEqual([]);
    expect(codeSpans("``")).toEqual([]);
    expect(codeSpans("` `")).toEqual([]); // only spaces
    expect(codeSpans("```ts")).toEqual([]); // a fence, not a span
    expect(codeSpans("a `b\nc` d")).toEqual([]); // spans never cross a line
    expect(inlineHtml("say `<b>`")).toBe('say `<code data-md="code" class="' + inlineHtml("`x`").split('class="')[1]!.split('"')[0] + '">&lt;b&gt;</code>`');
  });

  test("round-trips text with code, unclosed backticks and mentions next to code", () => {
    for (const text of ["say `foo` and `bar`", "unclosed `code here", "`a` `b`", "line `one`\nline `two`\n", "``double`` and ```"]) expect(roundTrip(text).text).toBe(text);
    const text = "see `x` $skill `y`";
    const start = text.indexOf("$skill");
    const mention = create(MentionSchema, { kind: MentionKind.SKILL, name: "skill", start, end: start + 6 });
    const value = roundTrip(text, [mention]);
    expect(value.text).toBe(text);
    expect(value.mentions.map((m) => value.text.slice(m.start, m.end))).toEqual(["$skill"]);
  });
});

describe("live markdown: fenced blocks", () => {
  test("complete fences only, written back the same way", () => {
    const text = "intro\n```ts\nconst a = 1;\n```\noutro";
    expect(findFences(text)).toEqual([{ lang: "ts", code: "const a = 1;", fence: 3, start: 6, end: 28 }]);
    expect(findFences("```ts\nno end")).toEqual([]);
    expect(findFences("``` ts title\nx\n```")).toEqual([]); // an info string with spaces stays text
    expect(findFences("~~~\nx\n~~~")).toEqual([]);
    expect(findFences("```\n\n```")).toEqual([]); // one empty line: a block would write "```\n```"
    expect(fenceText({ lang: "", code: "", fence: 3 })).toBe("```\n```");
    // Code with a fence line of its own gets longer fences.
    expect(fenceText({ lang: "md", code: "```js\nx\n```", fence: 3 })).toBe("````md\n```js\nx\n```\n````");
    expect(findFences("````md\n```js\nx\n```\n````")).toMatchObject([{ lang: "md", code: "```js\nx\n```", fence: 4 }]);
    expect(openingFence("```ts")).toEqual({ lang: "ts", fence: 3 });
    expect(openingFence("```ts x")).toBeUndefined();
  });

  test("blocks round-trip with and without a language, with text and empty lines around", () => {
    const texts = [
      "```ts\nconst a = 1;\n```",
      "```\nplain\n  indented\n```",
      "before\n```py\nprint(1)\n```\nafter",
      "before\n\n```py\nx\n```\n\nafter",
      "\n```\nx\n```",
      "```\nx\n```\n",
      "```a\n1\n```\n```b\n2\n```",
      "```a\n1\n```\n\n```b\n2\n```",
      "```\n```",
      "```sh\n\n\n```",
      "x `y`\n```js\nconst s = `t`;\n```\nz `w`",
      "````md\n```js\nx\n```\n````",
      "unclosed\n```ts\nconst a = 1;",
    ];
    for (const text of texts) expect(roundTrip(text).text).toBe(text);
  });

  test("a block in the DOM is its fence; a mention keeps its range after it", () => {
    const text = "```ts\nlet a\n```\nask $skill";
    const start = text.indexOf("$skill");
    const value = roundTrip(text, [create(MentionSchema, { kind: MentionKind.SKILL, name: "skill", start, end: start + 6 })]);
    expect(value.text).toBe(text);
    expect(value.mentions[0]).toMatchObject({ start, end: start + 6 });
    // A fence with a mention inside stays text.
    const inside = "```\n$skill\n```";
    expect(toHtml({ text: inside, mentions: [create(MentionSchema, { kind: MentionKind.SKILL, name: "skill", start: 4, end: 10 })] })).not.toContain("data-block");
  });

  test("DOM the browser builds: lines as text, the block between them", () => {
    const text = (data: string): EditorNode => ({ nodeType: 3, nodeName: "#text", textContent: data, childNodes: [] });
    const block = (code: string, lang = ""): EditorNode => ({ nodeType: 1, nodeName: "DIV", textContent: "", childNodes: [], dataset: { block: "code", code, lang, fence: "3" } });
    const br = (): EditorNode => ({ nodeType: 1, nodeName: "BR", textContent: "", childNodes: [] });
    const root = (...children: EditorNode[]): EditorNode => ({ nodeType: 1, nodeName: "DIV", textContent: null, childNodes: children });
    expect(serialize(root(text("abc\n"), block("x", "ts"), text("def"))).text).toBe("abc\n```ts\nx\n```\ndef");
    expect(serialize(root(text("abc"), block("x"))).text).toBe("abc\n```\nx\n```");
    // The line the caret was put on below a last block.
    expect(serialize(root(block("x"), br())).text).toBe("```\nx\n```\n");
  });
});
