import { describe, expect, test } from "bun:test";
import { citationLabel } from "./inline.ts";
import { citationHasMarkdown, citationPreview, citationTitle, citationTokenLabel } from "./preview.ts";
import type { NotedQuote } from "./quotes.ts";

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
