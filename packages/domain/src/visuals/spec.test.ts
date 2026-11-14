import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { JsonObject, JsonValue } from "../json.ts";
import { compileVisual, escapeHtml, visualPolicy, visualToken } from "./compile.ts";
import { VISUAL_LIMITS } from "./limits.ts";
import { parseFrameMessage, parseHostMessage } from "./protocol.ts";
import { validVisualState } from "./semantics.ts";
import { decodeVisualSpec, type DecodedVisual } from "./spec.ts";
import { visualTheme } from "./theme.ts";

const playground: JsonValue = {
  schema_version: 1,
  state: { variant: "primary", step: 0, dark: false },
  root: {
    type: "stack",
    children: [
      { type: "segmented", label: "Variant", state_key: "variant", options: ["primary", "secondary", "ghost"] },
      { type: "button_preview", label: "Add worker", variant_from: "variant" },
      { type: "toggle", label: "Dark", state_key: "dark" },
      { type: "stepper", state_key: "step", steps: [{ title: "One" }, { title: "Two" }, { title: "Three" }] },
      {
        type: "button",
        label: "Next",
        actions: [
          { action: "next", state_key: "step" },
          { action: "toggle", state_key: "dark" },
        ],
      },
    ],
  },
};

function ok(raw: JsonValue): DecodedVisual {
  const decoded = decodeVisualSpec(raw);

  if (Result.isFailure(decoded)) throw new Error(decoded.failure);

  return decoded.success;
}

function problem(raw: JsonValue): string {
  const decoded = decodeVisualSpec(raw);

  if (Result.isSuccess(decoded)) throw new Error("expected a validation error");

  return decoded.failure;
}

const withRoot = (root: JsonValue, state: JsonValue = {}): JsonObject => ({ schema_version: 1, state, root });

describe("visual spec validation", () => {
  test("accepts stored v1 lists and additive rows in the same compiled document", () => {
    const visual = ok(
      withRoot({
        type: "list",
        items: [
          "Stored bullet",
          { label: "Salary", detail: "Incoming transfer", value: "+8 500 zł", tone: "success" },
          { label: "<img src=x onerror=alert(1)>", value: "−18 zł", tone: "danger" },
          { label: "Pending" },
        ],
      }),
    );

    const html = compileVisual(visual, {
      title: "Rows",
      mode: "export",
      nonce: "canopy-list-compatibility",
      instance: "rows",
    });

    expect(html).toContain("Stored bullet");
    expect(html).toContain("Incoming transfer");
    expect(html).not.toContain("<img src=x");
    expect(ok(withRoot({ type: "list", ordered: true, items: ["One", "Two"] })).spec.schema_version).toBe(1);
  });

  test("rejects unsafe, unknown and oversized list row fields", () => {
    for (const row of [
      { label: "Salary", tone: "pink" },
      { label: "Salary", html: "<b>unsafe</b>" },
      { label: "Salary", value: "x".repeat(121) },
      { label: "" },
      { value: "12" },
      { label: "Salary", detail: "x".repeat(501) },
    ])
      expect(Result.isFailure(decodeVisualSpec(withRoot({ type: "list", items: [row] })))).toBe(true);
    const rows = Array.from({ length: 50 }, () => ({ label: "x".repeat(500), detail: "y".repeat(500) }));
    expect(problem(withRoot({ type: "list", items: rows }))).toContain("text is longer than 32 KiB");
  });

  test("derives state domains from controls", () => {
    const { domains } = ok(playground);

    expect(domains.get("variant")).toEqual({ kind: "enum", values: ["primary", "secondary", "ghost"] });
    expect(domains.get("step")).toEqual({ kind: "number", min: 0, max: 2 });
    expect(domains.get("dark")).toEqual({ kind: "boolean" });
  });

  test("rejects unknown fields, components, tokens and code-like fields", () => {
    expect(problem({ ...withRoot({ type: "divider" }), html: "<b>" })).toContain("excess property");
    expect(problem(withRoot({ type: "text", text: "x", onClick: "alert(1)" }))).toContain("onClick");
    expect(problem(withRoot({ type: "text", text: "x", style: "color:red" }))).toContain("style");
    expect(problem(withRoot({ type: "html", html: "<script>" }))).toContain("Expected");
    expect(problem(withRoot({ type: "badge", text: "x", tone: "pink" }))).toContain('"danger"');
    expect(problem({ schema_version: 2, root: { type: "divider" } })).toContain("schema_version");
  });

  test("enforces node count, depth, text and size limits before rendering", () => {
    const many = Array.from({ length: VISUAL_LIMITS.nodes }, () => ({ type: "divider" }));
    expect(problem(withRoot({ type: "stack", children: many }))).toContain(`more than ${VISUAL_LIMITS.nodes} nodes`);

    let deep: JsonValue = { type: "divider" };

    for (let level = 0; level < VISUAL_LIMITS.depth; level++) deep = { type: "stack", children: [deep] };
    expect(problem(withRoot(deep))).toContain("deeper than 12 levels");

    let hostile: JsonValue = [];

    for (let level = 0; level < 10_000; level++) hostile = [hostile];
    expect(problem(withRoot({ type: "stack", children: hostile }))).toContain("deeper");

    const texts = Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(3999) }));
    expect(problem(withRoot({ type: "stack", children: texts }))).toContain("text is longer than 32 KiB");

    const big = Array.from({ length: 40 }, () => ({ type: "code", text: "y".repeat(3999) }));
    expect(problem(withRoot({ type: "stack", children: big }))).toContain("larger than 128 KiB");
  });

  test("checks state references and values", () => {
    const segmented = { type: "segmented", label: "V", state_key: "variant", options: ["a", "b"] };

    expect(problem(withRoot(segmented))).toContain('"variant" is used but not declared');
    expect(problem(withRoot(segmented, { variant: "c" }))).toContain('"c" is not a value of "variant"');
    expect(problem(withRoot({ type: "toggle", label: "T", state_key: "variant" }, { variant: "a" }))).toContain(
      "holds options, not true/false",
    );

    const set = { type: "button", label: "B", actions: [{ action: "set", state_key: "variant", value: "zzz" }] };
    expect(problem(withRoot({ type: "stack", children: [segmented, set] }, { variant: "a" }))).toContain("zzz");

    const preview = { type: "button_preview", label: "B", variant_from: "variant" };
    expect(problem(withRoot({ type: "stack", children: [segmented, preview] }, { variant: "a" }))).toContain(
      "can't use",
    );

    const tooMany = { type: "button", label: "B", actions: Array.from({ length: 9 }, () => ({ action: "reset" })) };
    expect(problem(withRoot(tooMany))).toContain("at most 8");
  });

  test("checks diagram and chart references", () => {
    const flow = { type: "flow", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "missing" }] };
    expect(problem(withRoot(flow))).toContain("must name nodes");

    const chart = {
      type: "chart",
      kind: "bar",
      label: "C",
      categories: ["a", "b"],
      series: [{ name: "s", values: [1] }],
    };

    expect(problem(withRoot(chart))).toContain("one value per category");
  });

  test("validates cached local state against the spec", () => {
    const { domains } = ok(playground);

    expect(validVisualState(domains, { variant: "ghost", step: 2, dark: true })).toBe(true);
    expect(validVisualState(domains, { variant: "evil" })).toBe(false);
    expect(validVisualState(domains, { step: 3 })).toBe(false);
    expect(validVisualState(domains, { unknown: true })).toBe(false);
  });
});

describe("visual compiler", () => {
  const hostile = withRoot({
    type: "stack",
    children: [
      { type: "text", text: "</script><script>alert(1)</script><!--" },
      { type: "list", items: ["<img src=x onerror=alert(1)>", " line"] },
    ],
  });

  test("keeps model text inert and the document closed", () => {
    const nonce = visualToken();

    const html = compileVisual(ok(hostile), {
      title: '</title><script>alert("t")</script>',
      mode: "frame",
      nonce,
      instance: "a1",
      theme: visualTheme("birch", "dark"),
    });

    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain(escapeHtml('</title><script>alert("t")</script>'));
    expect(html).toContain(`content="${visualPolicy(nonce)}"`);

    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'"])
      expect(visualPolicy(nonce)).toContain(directive);

    const data = html.slice(html.indexOf('id="canopy-visual-data">') + 24, html.indexOf("</script>"));
    expect(JSON.parse(data).spec.root.children[0].text).toBe("</script><script>alert(1)</script><!--");
  });

  test("rejects malformed mount identifiers and themes, drops foreign state", () => {
    const visual = ok(playground);
    const theme = visualTheme("birch", "light");

    expect(() =>
      compileVisual(visual, { title: "t", mode: "frame", nonce: "x'; script-src *", instance: "a" }),
    ).toThrow();
    expect(() =>
      compileVisual(visual, {
        title: "t",
        mode: "frame",
        nonce: visualToken(),
        instance: "a",
        theme: { ...theme, colors: { ...theme.colors, ink: "red;background:url(https://x)" } },
      }),
    ).toThrow();

    const html = compileVisual(visual, {
      title: "t",
      mode: "export",
      nonce: visualToken(),
      instance: "a",
      state: { variant: "evil" },
    });

    expect(html).toContain('"state":{}');
  });
});

describe("host protocol", () => {
  test("parses only known, bounded messages", () => {
    expect(parseFrameMessage({ type: "height", height: 400 })).toEqual({ type: "height", height: 400 });
    expect(parseFrameMessage({ type: "height", height: -1 })).toBeUndefined();
    expect(parseFrameMessage({ type: "navigate", url: "https://example.com" })).toBeUndefined();
    expect(
      parseFrameMessage({ type: "local_state", state: { a: "x".repeat(VISUAL_LIMITS.stateBytes) } }),
    ).toBeUndefined();
    expect(parseHostMessage({ type: "visibility", visible: "yes" })).toBeUndefined();
    expect(parseHostMessage({ type: "reset" })).toEqual({ type: "reset" });
    expect(parseFrameMessage({ type: "escape" })).toEqual({ type: "escape" });
    expect(parseFrameMessage({ type: "keydown", key: "a" })).toBeUndefined();
  });
});
