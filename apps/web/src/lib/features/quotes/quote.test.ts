import { describe, expect, test } from "bun:test";
import { quoteLabel, toWire, type QuoteDraft } from "./quote.ts";

const draft: QuoteDraft = { id: "q", text: "x", comment: "", sourceItemId: "item-1", sourceThreadId: "t-1", sourceKind: "code", language: "" };

describe("quote drafts", () => {
  test("a chip shows the beginning of the quote on one line, ellipsized", () => {
    expect(quoteLabel("Dostępność i ruch: pełna obsługa transportu publicznego")).toBe("Dostępność i ruch: pełna obsługa…");
    expect(quoteLabel("  krótki\n\ttekst ")).toBe("krótki tekst");
  });

  test("SendMessage gets the quote without empty fields; the comment trimmed", () => {
    expect(toWire(draft)).toEqual({ text: "x", sourceItemId: "item-1", sourceThreadId: "t-1", sourceKind: "code" });
    expect(toWire({ ...draft, comment: "  why? ", language: "ts" })).toMatchObject({ comment: "why?", language: "ts" });
  });
});
