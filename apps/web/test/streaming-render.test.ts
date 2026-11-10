import { expect, test } from "bun:test";
import { lexMarkdown } from "@canopy/domain/markdown";
import { StreamingTokens } from "../src/lib/shared/ui/markdown/streaming-tokens.ts";
import { OutputChunks } from "../src/lib/shared/ui/streaming/output-chunks.ts";

test("incremental Markdown matches the full lexer at every streamed boundary", () => {
  const documents = [
    "First **paragraph**.\n\nSecond paragraph\ncontinued.\n\nHeading\n---\n\nDone.",
    "# Heading\n\n- first\n- second\n\n  continuation\n\n- third\n\nAfter.",
    "> quoted\n> text\n\nlazy continuation\n\n> another quote\n\nDone.",
    "Before.\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nAfter.",
    "Before.\n\n    indented\n\n    more code\n\nAfter.\n",
    "Before.\n\n| a | b |\n| - | - |\n| x | y |\n\nAfter.",
    "Use [guide][ref].\n\nOther paragraph.\n\n[ref]: https://example.com\n",
    "Before.\n\n$$\nx^2\n$$\n\nInline $y$ and **bold**.\n",
    "Before.\r\n\r\nAfter.\r\n\tindented\r\n",
    "<div>\ntext\n</div>\n\nAfter.\n\n---\n\nEnd.",
  ];

  for (const document of documents) {
    const parser = new StreamingTokens();

    for (let end = 1; end <= document.length; end++) {
      const text = document.slice(0, end);
      expect(parser.update(text)).toEqual([...lexMarkdown(text)]);
    }
  }
});

test("Markdown retains independent blocks and reparses edits, references and line-break options", () => {
  const parser = new StreamingTokens();
  const first = parser.update("First.\n\nSecond.");
  const next = parser.update("First.\n\nSecond. More.");
  expect(next[0]).toBe(first[0]);

  for (const text of ["Edited.\n\nSecond.", "", "[ref]\n\n[ref]: https://example.com\n", "line\nbreak"]) {
    expect(parser.update(text)).toEqual([...lexMarkdown(text)]);
    expect(parser.update(text, true)).toEqual([...lexMarkdown(text, true)]);
  }
});

test("output chunks preserve every byte across appends, partial lines, replacements and truncation", () => {
  const output = new OutputChunks();
  const text = Array.from({ length: 97 }, (_, i) => `${i}\tline with spaces  \n`).join("") + "partial";

  for (let end = 1; end < text.length; end += 7) {
    const source = text.slice(0, end);
    expect(output.update(source).join("")).toBe(source);
  }

  const before = output.update(text);
  const after = output.update(text + " line\n");
  expect(after[0]).toBe(before[0]);
  expect(after.join("")).toBe(text + " line\n");

  for (const source of ["replaced\n\n", "", "\t", text, text.slice(0, 31), "\n".repeat(64)])
    expect(output.update(source).join("")).toBe(source);
});
