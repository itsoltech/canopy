import { sha256 } from "@noble/hashes/sha2.js";
import { parse, serialize, defaultTreeAdapter as adapter, html, type DefaultTreeAdapterMap } from "parse5";
import { Schema } from "effect";
import { HtmlSource, htmlDocumentProblem } from "./html-source.ts";
import { HTML_LOCKDOWN, htmlBootstrap } from "./html-lockdown.ts";
import { validVisualTheme, type VisualTheme } from "./theme-tokens.ts";

type Node = DefaultTreeAdapterMap["node"];

type Element = DefaultTreeAdapterMap["element"];

const OMIT = new Set(["meta", "base", "link", "iframe", "frame", "frameset", "object", "embed"]);

export function htmlScriptHash(script: string): string {
  return `'sha256-${btoa(String.fromCharCode(...sha256(new TextEncoder().encode(script))))}'`;
}

export function htmlPolicy(hashes: readonly string[]): string {
  return [
    "default-src 'none'",
    `script-src ${hashes.join(" ")}`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ].join("; ");
}

function element(node: Node): node is Element {
  return "tagName" in node;
}

function clean(parent: DefaultTreeAdapterMap["parentNode"], scripts: string[], depth = 0): void {
  if (depth > 100) throw new Error("HTML nesting exceeds 100 levels");
  parent.childNodes = parent.childNodes.filter((node) => {
    if (!element(node)) return true;

    if (OMIT.has(node.tagName)) return false;

    // Foreign-content style parsing can change across serialization and browser reparsing (mXSS).
    if (node.tagName === "style" && node.namespaceURI !== html.NS.HTML) return false;

    if (node.tagName === "script") {
      const type = node.attrs.find((a) => a.name === "type")?.value.toLowerCase();

      if (
        !node.attrs.some((a) => a.name === "src") &&
        (!type || type === "text/javascript" || type === "application/javascript")
      ) {
        if (scripts.length >= 65) throw new Error("HTML exceeds 64 scripts");
        scripts.push(HTML_LOCKDOWN + node.childNodes.flatMap((n) => ("value" in n ? [n.value] : [])).join(""));
      }

      return false;
    }

    node.attrs = node.attrs.filter(
      (a) =>
        !a.name.startsWith("on") &&
        !["href", "xlink:href", "action", "formaction", "ping", "srcdoc", "nonce", "integrity", "is"].includes(a.name),
    );

    if ("content" in node) clean(node.content, scripts, depth + 1);
    clean(node, scripts, depth + 1);

    return true;
  });
}

export interface CompiledHtml {
  readonly html: string;
  readonly hashes: readonly string[];
}

/** The publish boundary applies the same structural limits as every renderer. */
export function validateHtmlDocument(source: string): void {
  const problem = htmlDocumentProblem(source);

  if (problem) throw new Error(problem);
  clean(parse(source), [""]);
}

function node(tag: string, attributes: Record<string, string>, text?: string): Element {
  const result = adapter.createElement(
    tag,
    html.NS.HTML,
    Object.entries(attributes).map(([name, value]) => ({ name, value })),
  );

  if (text !== undefined) adapter.insertText(result, text);

  return result;
}

/** Parse and rebuild before any browser sees agent markup. Additional CSP metas cannot widen this policy. */
export function compileHtml(
  specJson: string,
  options: {
    readonly nonce: string;
    readonly instance: string;
    readonly theme?: VisualTheme;
  },
): CompiledHtml {
  if (specJson.length > 6 * 512 * 1024 + 64) throw new Error("HTML source is too large");
  const source = Schema.decodeUnknownSync(Schema.fromJsonString(HtmlSource))(specJson);
  const problem = htmlDocumentProblem(source.html);

  if (problem) throw new Error(problem);

  if (options.theme && !validVisualTheme(options.theme)) throw new Error("Invalid theme");
  const tree = parse(source.html);
  const scripts = [htmlBootstrap(options.instance, options.nonce)];
  clean(tree, scripts);
  const hashes = scripts.map(htmlScriptHash);
  const theme = options.theme;

  const colors = theme
    ? Object.entries(theme.colors)
        .map(([key, value]) => `--canopy-${key}:${value}`)
        .join(";")
    : "--canopy-canvas:#ffffff;--canopy-surface:#f5f5f5;--canopy-panel:#eeeeee;--canopy-ink:#171717;--canopy-muted:#666666;--canopy-border:#dddddd;--canopy-accent:#4778f5;--canopy-action:#4778f5;--canopy-on-accent:#ffffff";

  const style = `:root{${colors};color-scheme:${theme?.mode ?? "light dark"}}body{margin:0;background:var(--canopy-canvas);color:var(--canopy-ink);font-family:system-ui}`;
  const root = tree.childNodes.find((n) => element(n) && n.tagName === "html");

  if (!root || !element(root)) throw new Error("Missing HTML root");
  const head = root.childNodes.find((n) => element(n) && n.tagName === "head");
  const body = root.childNodes.find((n) => element(n) && n.tagName === "body");

  if (!head || !body || !element(head) || !element(body)) throw new Error("Missing HTML document sections");

  const prefix = [
    node("meta", { "http-equiv": "Content-Security-Policy", content: htmlPolicy(hashes) }),
    node("meta", { name: "referrer", content: "no-referrer" }),
    node("style", {}, style),
  ];

  for (const child of prefix.reverse()) {
    if (head.childNodes[0]) adapter.insertBefore(head, child, head.childNodes[0]);
    else adapter.appendChild(head, child);
  }

  for (const script of scripts) adapter.appendChild(body, node("script", {}, script));

  tree.childNodes = tree.childNodes.filter((child) => child.nodeName !== "#documentType");

  return { html: "<!doctype html>" + serialize(tree), hashes };
}
