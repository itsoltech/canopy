import { describe, expect, test } from "bun:test";
import { citationLabel, composeQuotes } from "./inline.ts";
import { citationHasMarkdown, citationPreview, citationTitle, citationTokenLabel } from "./preview.ts";
import { isQuoteSourceKind, quoteBlock, type NotedQuote } from "./quotes.ts";

const comment: NotedQuote = {
  text: "**Claude finished the task in 55s**\n\n---\n### Re-review\n- [x] Review [changes](https://github.com/itsoltech/canopy)\n- [ ] Run `bun test`\n\n```ts\nconst ready = true;\n```",
  sourceKind: "pull_request",
  sourceAuthor: "claude[bot]",
  sourceTime: "2026-11-13T10:00:00Z",
  comment: "Keep **this note** literal.",
  pullRequest: {
    pullRequestId: "pr",
    kind: "review_comment",
    resourceId: "comment",
    repository: "itsoltech/canopy",
    number: 42,
    url: "https://github.com/itsoltech/canopy/pull/42#discussion_r1",
    path: "src/safe.ts",
    line: 3,
    diffHunk: "",
    firstLine: 0,
  },
};

describe("citation display forms", () => {
  test("labels strip markdown before truncating and keep the bot's literal name", () => {
    expect(citationTokenLabel(comment)).toBe("@claude[bot] · Claude finished the task in 55s…");
    expect(citationLabel(comment.text, 200)).toBe(
      "Claude finished the task in 55s Re-review Review changes Run bun test const ready = true;",
    );
    expect(citationLabel("# **Review** [the `diff`](https://example.com/a_(b))", 100)).toBe("Review the diff");
    expect(citationLabel("- [x] __Done__\n- [ ] *Next* and ~~old~~", 100)).toBe("Done Next and old");
  });

  test("body, source, link and literal note stay separate from the plain title", () => {
    expect(citationPreview(comment)).toEqual({
      text: comment.text,
      markdown: true,
      caption: "claude[bot] · itsoltech/canopy#42 · src/safe.ts:3 · 2026-11-13T10:00:00Z",
      url: comment.pullRequest!.url,
      comment: comment.comment ?? "",
    });
    const title = citationTitle(comment);
    expect(title).toContain("Review changes");
    expect(title).not.toContain("[x]");
    expect(title).not.toContain("```ts");
    expect(title).toEndWith("Keep **this note** literal.");
  });

  test("rendered selections and code-like sources keep their literal punctuation", () => {
    const text = "# literal **stars** and `code`";

    for (const sourceKind of [
      "agent_message",
      "reasoning",
      "text_selection",
      "code",
      "diff",
      "command_output",
      "tool_call",
      "file",
      "",
      "future_kind",
    ]) {
      const quote = { ...comment, sourceKind, text };
      expect(citationHasMarkdown(quote)).toBe(false);
      expect(citationPreview(quote).text).toBe(text);
      expect(citationTokenLabel(quote)).toBe(`@claude[bot] · ${text}`);
      expect(citationTitle(quote)).toStartWith(text);
    }

    for (const kind of ["log", "job", "check"]) {
      expect(citationHasMarkdown({ ...comment, pullRequest: { ...comment.pullRequest!, kind } })).toBe(false);
    }

    expect(citationHasMarkdown({ text, sourceKind: "agent_message_markdown" })).toBe(true);
  });
});

describe("file citations in model input", () => {
  const file: NotedQuote = {
    text: "\n\tconst value = `literal`;  \n\n",
    sourceKind: "file",
    sourceAuthor: "src/nested folder/example.ts",
    language: "ts",
    comment: "  Keep the indentation.  ",
  };

  test("inline composition includes the workspace path and exact selection at the marker", () => {
    const message = "Review [file] please.";
    const result = composeQuotes(message, [], [{ ...file, start: 7, end: 13 }]);

    expect(isQuoteSourceKind("file")).toBe(true);
    expect(result.message).toBe(
      "Review \n\n[canopy citation 1]\nFile src/nested folder/example.ts:\n```ts\n" +
        "\n\tconst value = `literal`;  \n\n```\n\nComment: Keep the indentation.\n[/canopy citation 1]\n\n please.",
    );
    expect(result.note).toBe("");
  });

  test("legacy notes include the file path and preserve selection whitespace", () => {
    const result = composeQuotes("Review this file.", [], [{ ...file, language: "" }]);

    expect(result.message).toBe("Review this file.");
    expect(result.note).toContain(
      "Quote 1, from a file:\nFile src/nested folder/example.ts:\n```text\n" +
        "\n\tconst value = `literal`;  \n\n```\n\nComment: Keep the indentation.",
    );
  });

  test.each(["\t```ts\nvalue\n```\n", "before ````` after\r\n\tvalue  \r\n\r\n"])(
    "embedded backticks cannot close the file fence: %s",
    (text) => {
      const block = quoteBlock({ ...file, text });
      const fence = text.includes("`````") ? "``````" : "````";

      expect(block).toBe(`File src/nested folder/example.ts:\n${fence}ts\n${text}${fence}`);
    },
  );

  test.each(["value", "value\n", "value\n\n"])("file fences do not add blank lines: %j", (text) => {
    expect(quoteBlock({ ...file, text })).toBe(
      `File src/nested folder/example.ts:\n\`\`\`ts\n${text}${text.endsWith("\n") ? "" : "\n"}\`\`\``,
    );
  });

  test("line breaks in filenames stay in the provenance label", () => {
    expect(quoteBlock({ ...file, sourceAuthor: "src/first\nsecond.ts", text: "value" })).toBe(
      'File "src/first\\nsecond.ts":\n```ts\nvalue\n```',
    );
  });

  test("preview keeps literal file contents and uses the relative path as provenance", () => {
    expect(citationPreview(file)).toEqual({
      text: "const value = `literal`;",
      markdown: false,
      caption: "src/nested folder/example.ts",
      url: "",
      comment: "Keep the indentation.",
    });
    expect(citationPreview({ ...file, sourceAuthor: "" }).caption).toBe("File");
  });
});
