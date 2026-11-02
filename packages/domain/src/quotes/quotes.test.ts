import { describe, expect, test } from "bun:test";
import { fenceFor, joinNotes, quoteBlock, quotesNote } from "./quotes.ts";

describe("quoteBlock: the exact text, as markdown the agent reads back", () => {
  test("prose is a blockquote with every line marked, empty lines kept", () => {
    expect(quoteBlock({ text: "Dostępność i ruch: pełna obsługa.\n\nDruga linia\n", sourceKind: "agent_message" })).toBe(
      "> Dostępność i ruch: pełna obsługa.\n>\n> Druga linia",
    );
  });

  test("command output, tool calls, code and diffs are fenced, with the code's language", () => {
    expect(quoteBlock({ text: "  ok 12 tests\nFAIL a.test.ts", sourceKind: "command_output" })).toBe("```text\n  ok 12 tests\nFAIL a.test.ts\n```");
    expect(quoteBlock({ text: "const a = 1;", sourceKind: "code", language: "ts" })).toBe("```ts\nconst a = 1;\n```");
    expect(quoteBlock({ text: "-a\n+b", sourceKind: "diff" })).toBe("```diff\n-a\n+b\n```");
  });

  test("a fence is longer than any backtick run inside, and a language cannot break out of the info string", () => {
    expect(fenceFor("no ticks")).toBe("```");
    expect(fenceFor("a ```` b")).toBe("`````");
    expect(quoteBlock({ text: "```\nx\n```", sourceKind: "code", language: "md\n# hi" })).toBe("````md#hi\n```\nx\n```\n````");
  });
});

describe("quotesNote: the stable format before the user's text", () => {
  test("numbers each quote with where it came from, then the comment when there is one", () => {
    const note = quotesNote([
      { text: "Pełna obsługa", comment: "  Skróć to.  ", sourceKind: "agent_message" },
      { text: "exit 1", sourceKind: "command_output" },
      { text: "bez źródła" },
    ]);
    expect(note).toBe(
      [
        "[open-agents] The user quoted 3 passages of this conversation. Each quote is the exact text they selected, followed by their comment on it when they wrote one; their message comes after the quotes.",
        "Quote 1, from your message:\n> Pełna obsługa\n\nComment: Skróć to.",
        "Quote 2, from command output:\n```text\nexit 1\n```",
        "Quote 3, from this conversation:\n> bez źródła",
      ].join("\n\n"),
    );
  });

  test("one quote reads in the singular; none is no note", () => {
    expect(quotesNote([{ text: "x", sourceKind: "reasoning" }])).toStartWith("[open-agents] The user quoted a passage of this conversation.");
    expect(quotesNote([{ text: "x", sourceKind: "reasoning" }])).toContain("Quote 1, from your reasoning:");
    expect(quotesNote([])).toBe("");
  });

  test("notes of one message join with an empty line, skipping empty ones", () => {
    expect(joinNotes("[open-agents] files", "", "[open-agents] quotes")).toBe("[open-agents] files\n\n[open-agents] quotes");
    expect(joinNotes("", "")).toBe("");
  });
});
