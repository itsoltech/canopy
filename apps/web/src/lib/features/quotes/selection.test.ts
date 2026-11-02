import { describe, expect, test } from "bun:test";
import { visibleText, type QuoteNode } from "./selection.ts";

/** A tiny element tree in the shape the walk reads (nodeType, nodeName, attributes, children). */
function h(name: string, attrs: Record<string, string> | null, ...children: (QuoteNode | string)[]): QuoteNode {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    nodeValue: null,
    childNodes: children.map((c) => (typeof c === "string" ? { nodeType: 3, nodeName: "#text", nodeValue: c, childNodes: [] } : c)),
    getAttribute: (key) => attrs?.[key] ?? null,
  };
}
const fragment = (...children: (QuoteNode | string)[]): QuoteNode => ({ ...h("#document-fragment", null, ...children), nodeType: 11 });

describe("visibleText: what the reader sees, not the markdown behind it", () => {
  test("rendered emphasis, code spans and links are their text; paragraphs are apart by an empty line", () => {
    const tree = fragment(
      h("p", null, "Dostępność i ruch: ", h("strong", null, "pełna"), " obsługa ", h("code", null, "npm test"), "."),
      "\n",
      h("p", null, "Zobacz ", h("a", { href: "https://x" }, "dokumentację"), "."),
    );
    expect(visibleText(tree)).toBe("Dostępność i ruch: pełna obsługa npm test.\n\nZobacz dokumentację.");
  });

  test("source whitespace between tags collapses like the browser renders it; <br> breaks a line", () => {
    expect(visibleText(fragment(h("p", null, "  one\n   two  ", h("br", null), "  three  ")))).toBe("one two\nthree");
  });

  test("list items are lines (their bullets are not text), a list is its own paragraph", () => {
    const tree = fragment(h("p", null, "Kroki:"), h("ul", null, h("li", null, h("p", null, "pierwszy")), h("li", null, "drugi")), h("p", null, "Koniec."));
    expect(visibleText(tree)).toBe("Kroki:\n\npierwszy\n\ndrugi\n\nKoniec.");
    expect(visibleText(fragment(h("ol", null, h("li", null, "a"), h("li", null, "b"))))).toBe("a\nb");
  });

  test("a code block keeps its lines and indentation; a highlighted line is its tokens' text", () => {
    const code = h("pre", { class: "code-surface max-h-96" }, h("span", null, "function a() {"), h("span", null, "\n", h("span", { style: "color:red" }, "  return"), " 1;"), h("span", null, "\n}"));
    expect(visibleText(fragment(h("p", null, "Kod:"), code))).toBe("Kod:\n\nfunction a() {\n  return 1;\n}");
  });

  test("a selection inside a code block (pre = true) keeps its whitespace exactly", () => {
    expect(visibleText(fragment("    ok 12 tests\n", "FAIL  a.test.ts\n"), true)).toBe("    ok 12 tests\nFAIL  a.test.ts");
  });

  test("diff lines are lines of the code surface, with their signs", () => {
    const diff = h("div", { class: "code-surface py-2" }, h("div", { class: "inline-block" }, h("div", null, "@@ -1 +1 @@"), h("div", null, h("span", null, "-"), "old"), h("div", null, h("span", null, "+"), "  new"), h("div", null, " ")));
    expect(visibleText(fragment(diff))).toBe("@@ -1 +1 @@\n-old\n+  new");
  });

  test("buttons, hidden and decorative parts are not text (copy buttons, language labels, show-all controls)", () => {
    const fence = h(
      "div",
      null,
      h("div", { "data-quote-skip": "" }, h("p", null, "ts"), h("button", null, "Copy code")),
      h("pre", null, "let a = 1;"),
      h("span", { "aria-hidden": "true" }, "▍"),
    );
    expect(visibleText(fragment(h("p", null, "Przed"), fence))).toBe("Przed\n\nlet a = 1;");
  });

  test("table cells are apart by a tab, rows by a line", () => {
    const table = h("table", null, h("tbody", null, h("tr", null, h("th", null, "Plik"), h("th", null, "Linie")), h("tr", null, h("td", null, "a.ts"), h("td", null, "12"))));
    expect(visibleText(fragment(table))).toBe("Plik\tLinie\na.ts\t12");
  });

  test("a selection of whitespace only is empty", () => {
    expect(visibleText(fragment(h("p", null, "   "), h("p", null, "\n")))).toBe("");
  });
});
