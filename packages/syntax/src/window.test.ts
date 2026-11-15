import { expect, test } from "bun:test";
import { SyntaxRole } from "@canopy/contracts";
import { WindowHighlighter } from "./window.ts";

test("cached line windows retain multiline grammar when revisited after a long scroll", async () => {
  const text = Array.from({ length: 20_000 }, (_, index) =>
    index % 4 === 0 ? "/* comment" : index % 4 === 1 ? "inside */" : 'const value = "text";',
  ).join("\n");

  const highlighter = new WindowHighlighter("source.ts", text);
  await highlighter.ready();

  for (let start = 1; start <= 20_000;) {
    const result = highlighter.render(start, 200);
    const last = result.lines.at(-1)?.line;
    expect(last).toBeDefined();
    start = (last ?? start) + 1;
  }

  const revisited = highlighter.render(1, 4);
  expect(revisited.incomplete).toBe(false);
  expect(revisited.lines).toHaveLength(4);
  expect(revisited.lines[1]?.spans.some((span) => span.role === SyntaxRole.COMMENT)).toBe(true);
  expect(revisited.lines[2]?.spans.some((span) => span.role === SyntaxRole.KEYWORD)).toBe(true);
});

test("an edit invalidates the grammar suffix and accounts for inserted and deleted lines", async () => {
  const text = "const before = 1;\n/*\nconst inside = 2;\n*/\nconst after = 3;";
  const highlighter = new WindowHighlighter("source.ts", text);
  await highlighter.ready();
  highlighter.render(1, 20);
  const from = text.indexOf("/*");
  highlighter.change([{ from, to: from + 3, insert: "\n" }]);
  const changed = text.slice(0, from) + "\n" + text.slice(from + 3);
  const expected = new WindowHighlighter("source.ts", changed);
  await expected.ready();
  expect(highlighter.render(1, 20)).toEqual(expected.render(1, 20));
  expect(highlighter.lineCount).toBe(changed.split("\n").length);
});

test.each([
  ["data.json", '{"name":"Canopy","enabled":true}'],
  ["settings.yaml", 'name: "Canopy"\nenabled: true'],
  ["source.py", 'def greet(name):\n    return "Hello " + name'],
])("background tokenization supports %s", async (path, text) => {
  const highlighter = new WindowHighlighter(path, text);
  await highlighter.ready();
  const result = highlighter.render(1, 20);
  expect(result.incomplete).toBe(false);
  expect(result.lines.some((line) => line.spans.length > 0)).toBe(true);
});
