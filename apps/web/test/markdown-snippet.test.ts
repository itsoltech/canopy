import { describe, expect, test } from "bun:test";
import type { Token } from "marked";
import { snippetTokens } from "../src/lib/shared/ui/markdown/tokens.ts";

/** Inline tokens back to a compact form: `**x**` for strong, `` `x` `` for code, plain text otherwise. */
const show = (tokens: Token[]): string =>
  tokens
    .map((t) => {
      if (t.type === "strong") return `**${show((t as { tokens: Token[] }).tokens)}**`;
      if (t.type === "em") return `_${show((t as { tokens: Token[] }).tokens)}_`;
      if (t.type === "codespan") return `\`${(t as { text: string }).text}\``;
      if ("tokens" in t && Array.isArray(t.tokens)) return show(t.tokens);
      return (t as { text?: string }).text ?? "";
    })
    .join("");

describe("snippetTokens", () => {
  test("keeps inline formatting and joins blocks with spaces", () => {
    expect(show(snippetTokens("**Wynik: zaliczony.** Skill obejmuje *cały* scenariusz.\n\n- punkt `a`\n- punkt b"))).toBe(
      "**Wynik: zaliczony.** Skill obejmuje _cały_ scenariusz. punkt `a` punkt b",
    );
  });

  test("links keep only their text, code blocks their first line, headings and quotes their content", () => {
    expect(show(snippetTokens("# Raport\n\n> cytat [link](https://example.com)\n\n```ts\n\nconst x = 1;\nmore\n```"))).toBe("Raport cytat link `const x = 1;`");
    expect(snippetTokens("[a](https://example.com)").some((t) => t.type === "link")).toBe(false);
  });
});
