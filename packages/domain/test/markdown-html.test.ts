import { describe, expect, test } from "bun:test";
import type { Token } from "marked";
import { isHtmlToken, isToken, lexMarkdown, normalizeHtmlTokens, type HtmlNode } from "../src/markdown/index.ts";

const html = (raw: string): Token => ({ type: "html", raw, text: raw, block: true, pre: false });

const nodesOf = (source: string) =>
  normalizeHtmlTokens([html(source)]).flatMap((token) => (isHtmlToken(token) ? token.nodes : []));

function flatten(nodes: HtmlNode[]): HtmlNode[] {
  const result: HtmlNode[] = [];
  const stack = nodes.toReversed();

  while (stack.length) {
    const node = stack.pop();

    if (!node) break;
    result.push(node);

    if (node.kind === "element") stack.push(...node.children.toReversed());
  }

  return result;
}

const elementsOf = (source: string) => flatten(nodesOf(source)).filter((node) => node.kind === "element");

describe("safe HTML AST boundary", () => {
  test("preserves Markdown token identity within inline HTML wrappers", () => {
    const paragraph = lexMarkdown("before <strong>one **two**</strong> after")[0];

    if (!paragraph || !isToken(paragraph, "paragraph")) throw new Error("Expected paragraph");
    const tokens = paragraph.tokens;
    const normalized = normalizeHtmlTokens(tokens);

    expect(normalized[0]).toBe(tokens[0]);
    expect(normalized[2]).toBe(tokens[5]);
    const wrapper = normalized[1];

    expect(wrapper && isHtmlToken(wrapper) && wrapper.nodes).toEqual([
      {
        kind: "element",
        tag: "strong",
        children: [
          { kind: "markdown", token: tokens[2] },
          { kind: "markdown", token: tokens[3] },
        ],
      },
    ]);
  });

  test("preserves block wrappers across blank lines, paragraphs and lists", () => {
    const tokens = lexMarkdown("<details open>\n<summary>More</summary>\n\n**one**\n\n- two\n\n</details>");
    const normalized = normalizeHtmlTokens(tokens);

    expect(normalized).toHaveLength(1);
    const token = normalized[0];

    if (!token || !isHtmlToken(token)) throw new Error("Expected HTML AST");
    const all = flatten(token.nodes);
    const details = all.find((node) => node.kind === "element" && node.tag === "details");

    expect(details).toMatchObject({ kind: "element", tag: "details", open: true });
    expect(all.filter((node) => node.kind === "markdown").map((node) => node.token)).toEqual(
      tokens.filter((original) => original.type !== "html"),
    );
    expect(all.some((node) => node.kind === "element" && node.tag === "summary")).toBe(true);
  });

  test("groups adjacent HTML nodes but keeps surrounding original Markdown tokens", () => {
    const before = lexMarkdown("before")[0]!;
    const after = lexMarkdown("after")[0]!;
    const normalized = normalizeHtmlTokens([before, html("<b>b</b>"), html("<i>i</i>"), after]);

    expect(normalized).toHaveLength(3);
    expect(normalized[0]).toBe(before);
    expect(normalized[2]).toBe(after);
    expect(isHtmlToken(normalized[1]!) && normalized[1].nodes).toHaveLength(2);
    expect(normalizeHtmlTokens(normalized)).toBe(normalized);
  });

  test("does not reinterpret code spans, fenced code, escaped HTML or encoded text", () => {
    for (const source of [
      "`<img src=x onerror=alert(1)>`",
      "```html\n<script>attack()</script>\n```",
      "\\<script>attack()\\</script>",
      "&lt;img src=x onerror=alert(1)&gt;",
    ]) {
      const tokens = lexMarkdown(source);

      expect(normalizeHtmlTokens(tokens)).toBe(tokens);
    }

    const code = lexMarkdown("```html\n<script>attack()</script>\n```")[0]!;
    const result = normalizeHtmlTokens([html("<div>"), code, html("</div>")]);
    const token = result[0];

    expect(token && isHtmlToken(token) && token.nodes).toEqual([
      { kind: "element", tag: "div", children: [{ kind: "markdown", token: code }] },
    ]);
    expect(nodesOf("&lt;script&gt;attack()&lt;/script&gt;")).toEqual([
      { kind: "text", text: "<script>attack()</script>" },
    ]);
  });

  test.each([
    "script",
    "style",
    "iframe",
    "object",
    "template",
    "form",
    "button",
    "textarea",
    "select",
    "option",
    "noscript",
    "xmp",
    "title",
  ])("drops the entire %s subtree", (tag) => {
    const source = `<${tag}>secret <strong>nested</strong></${tag}><p>visible</p>`;

    expect(nodesOf(source)).toEqual([{ kind: "element", tag: "p", children: [{ kind: "text", text: "visible" }] }]);
  });

  test("drops active void tags, comments, doctypes and foreign attributes", () => {
    expect(
      nodesOf(
        '<!doctype html><!--secret--><input autofocus onfocus=evil()><embed src=x><link href=x><meta http-equiv=refresh content=0><base href=https://evil.invalid><p xmlns:x="urn:evil" x:href="javascript:evil()">ok</p>',
      ),
    ).toEqual([{ kind: "element", tag: "p", children: [{ kind: "text", text: "ok" }] }]);
    expect(
      nodesOf("<svg><foreignObject><div>secret</div></foreignObject></svg><math><mtext>secret</mtext></math>"),
    ).toEqual([]);
  });

  test("sanitizes HTML that the parser moves outside foreign namespaces", () => {
    expect(
      nodesOf('<svg><strong onclick=evil()>safe</strong></svg><math><p style="position:fixed">text</p></math>'),
    ).toEqual([
      { kind: "element", tag: "strong", children: [{ kind: "text", text: "safe" }] },
      { kind: "element", tag: "p", children: [{ kind: "text", text: "text" }] },
    ]);
  });

  test("removes clobbering, styling, handlers, link targets and all unlisted attributes", () => {
    expect(
      nodesOf(
        '<a id=location name=cookie class=evil style="position:fixed" onclick=evil() onmouseover=evil() target=_top download ping=https://evil.invalid rel=opener href="https://example.com" title="A &amp; B">ok</a>',
      ),
    ).toEqual([
      {
        kind: "element",
        tag: "a",
        href: "https://example.com/",
        title: "A & B",
        children: [{ kind: "text", text: "ok" }],
      },
    ]);
  });

  test.each([
    "javascript:alert(1)",
    "jav&#x61;script:alert(1)",
    "javascript&colon;alert(1)",
    "java&#9;script:alert(1)",
    "java&#10;script:alert(1)",
    "&#1;javascript:alert(1)",
    "vbscript:evil()",
    "data:text/html,evil",
    "//evil.invalid/path",
    "https&colon;javascript:evil()",
    "javascript%3Aalert(1)",
  ])("rejects unsafe href %s after HTML entity decoding", (href) => {
    expect(elementsOf(`<a href="${href}">label</a>`)[0]).toEqual({
      kind: "element",
      tag: "a",
      children: [{ kind: "text", text: "label" }],
    });
  });

  test.each([
    ["https://example.com/a?b=1&amp;c=2", "https://example.com/a?b=1&c=2"],
    ["mailto:test@example.com", "mailto:test@example.com"],
    ["#heading", "#heading"],
    ["src/app.ts", "src/app.ts"],
    ["./docs/readme.md", "./docs/readme.md"],
    ["file:///workspace/report.md", "/workspace/report.md"],
  ])("retains a safe navigation target %s", (href, expected) => {
    expect(elementsOf(`<a href="${href}">label</a>`)[0]?.href).toBe(expected);
  });

  test("retains only inert image data and dimensions under the existing renderer policy", () => {
    expect(
      nodesOf(
        '<picture><source srcset="evil 2x"><img src="javascript:evil()" alt="&lt;script&gt;" width="320px" height="4096" onerror=evil() srcset="evil 2x" style="width:100vw"></picture>',
      ),
    ).toEqual([{ kind: "image", image: { src: "javascript:evil()", alt: "<script>", width: 320, height: 4096 } }]);

    for (const size of ["0", "4097", "-1", "1.5", "100%", "1e3", "12px;evil()"])
      expect(nodesOf(`<img src=x width="${size}" height="${size}">`)).toEqual([
        { kind: "image", image: { src: "x", alt: "", width: undefined, height: undefined } },
      ]);
  });

  test("keeps bounded semantic attributes on their appropriate elements", () => {
    expect(
      elementsOf(
        '<div align="CENTER" title=tip open start=2 colspan=3><details open="false"><summary>title</summary></details><ol start="-2"><li>x</li></ol><table><tr><td colspan=2 rowspan=0 align=right>cell</td></tr></table></div>',
      ),
    ).toMatchObject([
      { tag: "div", align: "center", title: "tip" },
      { tag: "details", open: true },
      { tag: "summary" },
      { tag: "ol", start: -2 },
      { tag: "li" },
      { tag: "table" },
      { tag: "tbody" },
      { tag: "tr" },
      { tag: "td", colspan: 2, rowspan: 0, align: "right" },
    ]);
    const div = elementsOf("<div open start=2 colspan=3>text</div>")[0]!;

    expect(div).toEqual({ kind: "element", tag: "div", children: [{ kind: "text", text: "text" }] });
    expect(
      elementsOf(
        "<ol start=9007199254740992></ol><table><tr><td colspan=1001 rowspan=65535 align=evil>x</td></tr></table>",
      ),
    ).toEqual(
      expect.arrayContaining([
        { kind: "element", tag: "ol", children: [] },
        { kind: "element", tag: "td", children: [{ kind: "text", text: "x" }] },
      ]),
    );
  });

  test("retains only single-source color scheme variants as inert picture data", () => {
    expect(
      nodesOf(
        '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><source media="(prefers-color-scheme: light)" srcset="light.svg 2x"><source media="(max-width: 400px)" srcset="small.svg"><img src="logo.svg" alt="Canopy"></picture>',
      ),
    ).toEqual([
      {
        kind: "image",
        image: {
          src: "logo.svg",
          alt: "Canopy",
          darkSrc: "dark.svg",
          lightSrc: undefined,
          width: undefined,
          height: undefined,
        },
      },
    ]);
  });

  test("unwraps harmless unknown tags without accepting tag-like escaped text", () => {
    expect(
      nodesOf(
        '<custom-widget><abbr title="Definition">term</abbr><source srcset=evil>&lt;img onerror=evil()&gt;</custom-widget>',
      ),
    ).toEqual([
      { kind: "element", tag: "abbr", title: "Definition", children: [{ kind: "text", text: "term" }] },
      { kind: "text", text: "<img onerror=evil()>" },
    ]);
  });

  test("cannot forge Markdown placeholders through collisions, case or entities", () => {
    const markdown = lexMarkdown("**trusted**")[0]!;

    const normalized = normalizeHtmlTokens([
      html(
        '<CANOPY-MARKDOWN-TOKEN data-index="1">fake</CANOPY-MARKDOWN-TOKEN><canopy-markdown-tokenx data-index="1">fake two</canopy-markdown-tokenx>&lt;canopy-markdown-tokenxx data-index="1"&gt;',
      ),
      markdown,
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[1]).toBe(markdown);
    const token = normalized[0];

    if (!token || !isHtmlToken(token)) throw new Error("Expected HTML AST");

    expect(token.nodes.every((node) => node.kind === "text")).toBe(true);
    expect(token.nodes.flatMap((node) => (node.kind === "text" ? [node.text] : [])).join("")).toBe(
      'fakefake two<canopy-markdown-tokenxx data-index="1">',
    );
  });

  test("handles streaming fragments without exposing incomplete attributes or active content", () => {
    const complete =
      '<details open><summary>More</summary><p>Hello <a href="javascript:evil()">bad</a></p><script>evil()</script></details>';

    for (let end = 1; end <= complete.length; end++) {
      const nodes = flatten(nodesOf(complete.slice(0, end)));

      for (const node of nodes) {
        if (node.kind !== "element") continue;
        expect(node.tag).not.toBe("script");
        expect(node.href).toBeUndefined();
      }
    }

    expect(nodesOf('<div>hello <a href="javascript:evil()')).toEqual([
      { kind: "element", tag: "div", children: [{ kind: "text", text: "hello " }] },
    ]);
  });

  test("drops placeholder tokens inside active subtrees rather than reviving them", () => {
    const markdown = lexMarkdown("secret")[0]!;

    expect(normalizeHtmlTokens([html("<script>"), markdown, html("</script>")])).toEqual([]);
    expect(normalizeHtmlTokens([html("<template>"), markdown, html("</template>")])).toEqual([]);
  });

  test("bounds rendered nesting while preserving text without a recursive sanitizer stack", () => {
    const depth = 10000;
    const nodes = flatten(nodesOf("<div>".repeat(depth) + "ok" + "</div>".repeat(depth)));

    expect(nodes).toHaveLength(65);
    expect(nodes.at(-1)).toEqual({ kind: "text", text: "ok" });
  });
});
