import type { Token, Tokens } from "marked";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { fileHrefOf } from "../file-references.ts";
import type { GitHubImage } from "../github-images.ts";
import { safeHref } from "./safe-url.ts";

const htmlTags = [
  "p",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "strike",
  "u",
  "ins",
  "sub",
  "sup",
  "kbd",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "details",
  "summary",
  "br",
  "hr",
  "a",
  "abbr",
] as const;

export type HtmlTag = (typeof htmlTags)[number];

export interface MarkdownImage extends GitHubImage {
  readonly lightSrc?: string | undefined;
  readonly darkSrc?: string | undefined;
}

export type HtmlNode =
  | { kind: "text"; text: string }
  | { kind: "image"; image: MarkdownImage }
  | { kind: "markdown"; token: Token }
  | {
      kind: "element";
      tag: HtmlTag;
      children: HtmlNode[];
      align?: "left" | "center" | "right";
      href?: string;
      title?: string;
      open?: boolean;
      start?: number;
      colspan?: number;
      rowspan?: number;
    };

export interface HtmlToken extends Tokens.Generic {
  type: "safeHtml";
  nodes: HtmlNode[];
}

export const isHtmlToken = (token: Token): token is HtmlToken => token.type === "safeHtml";

const allowedTags = new Set<string>(htmlTags);

const droppedTags = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "title",
]);

const isHtmlTag = (tag: string): tag is HtmlTag => allowedTags.has(tag);

type Element = DefaultTreeAdapterMap["element"];

type Child = DefaultTreeAdapterMap["childNode"];

const attr = (node: Element, name: string) =>
  node.attrs.find((attribute) => !attribute.namespace && attribute.name === name)?.value;

function integer(value: string | undefined, min: number, max: number): number | undefined {
  if (!value || !/^-?\d+$/.test(value)) return;
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

// Keep image dimensions consistent with githubHtmlParts; the image renderer validates src.
const dimension = (value: string | undefined) =>
  value && /^\d+(?:px)?$/.test(value) ? integer(value.replace(/px$/, ""), 1, 4096) : undefined;

function linkHref(value: string | undefined): string | undefined {
  if (!value) return;

  if (/^#[^\s\p{Cc}]*$/u.test(value)) return value;

  return safeHref(value) ?? fileHrefOf(value);
}

function elementOf(node: Element, tag: HtmlTag): Extract<HtmlNode, { kind: "element" }> {
  const element: Extract<HtmlNode, { kind: "element" }> = { kind: "element", tag, children: [] };
  const align = attr(node, "align")?.toLowerCase();
  const title = attr(node, "title");

  if (align === "left" || align === "center" || align === "right") element.align = align;

  if (title !== undefined) element.title = title;

  if (tag === "a") {
    const href = linkHref(attr(node, "href"));

    if (href !== undefined) element.href = href;
  }

  if (tag === "details" && attr(node, "open") !== undefined) element.open = true;

  if (tag === "ol") {
    const start = integer(attr(node, "start"), Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

    if (start !== undefined) element.start = start;
  }

  if (tag === "td" || tag === "th") {
    const colspan = integer(attr(node, "colspan"), 1, 1000);
    const rowspan = integer(attr(node, "rowspan"), 0, 65534);

    if (colspan !== undefined) element.colspan = colspan;

    if (rowspan !== undefined) element.rowspan = rowspan;
  }

  return element;
}

type PictureSources = Pick<MarkdownImage, "darkSrc" | "lightSrc">;

const pictures = new WeakMap<Element, PictureSources>();

function pictureSources(node: Element): PictureSources {
  const parent = node.parentNode;

  if (!parent || !("tagName" in parent) || parent.tagName !== "picture") return {};
  const cached = pictures.get(parent);

  if (cached) return cached;
  const sources = new Map<string, string>();

  for (const child of parent.childNodes) {
    if (!("tagName" in child)) continue;

    if (child.tagName === "img") break;

    if (child.tagName !== "source") continue;
    const scheme = /^\(prefers-color-scheme:\s*(light|dark)\)$/.exec(attr(child, "media")?.trim() ?? "")?.[1];
    const src = attr(child, "srcset")?.trim();

    if (scheme && src && /^[^\s,]+$/.test(src) && !sources.has(scheme)) sources.set(scheme, src);
  }

  const variants = sources.size ? { darkSrc: sources.get("dark"), lightSrc: sources.get("light") } : {};
  pictures.set(parent, variants);

  return variants;
}

/** Iterative traversal also handles adversarially deep HTML without consuming the JS call stack. */
function htmlNodes(children: Child[], marker: string, tokens: Token[]): HtmlNode[] {
  const nodes: HtmlNode[] = [];
  const stack = children.toReversed().map((node) => ({ node, into: nodes, depth: 0 }));

  while (stack.length) {
    const entry = stack.pop();

    if (!entry) break;
    const { node } = entry;

    if (node.nodeName === "#text" && "value" in node) entry.into.push({ kind: "text", text: node.value });

    if (!("tagName" in node)) continue;

    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || droppedTags.has(node.tagName)) continue;

    if (node.tagName === marker) {
      const index = integer(attr(node, "data-index"), 0, tokens.length - 1);
      const token = index === undefined ? undefined : tokens[index];

      if (token) entry.into.push({ kind: "markdown", token });
      continue;
    }

    if (node.tagName === "img") {
      entry.into.push({
        kind: "image",
        image: {
          ...pictureSources(node),
          src: attr(node, "src") ?? "",
          alt: attr(node, "alt") ?? "",
          width: dimension(attr(node, "width")),
          height: dimension(attr(node, "height")),
        },
      });
      continue;
    }

    let into = entry.into;
    let depth = entry.depth;

    // Bound the recursive component tree while preserving text inside excessive wrappers.
    if (isHtmlTag(node.tagName) && depth < 64) {
      const element = elementOf(node, node.tagName);
      into.push(element);
      into = element.children;
      depth++;
    }

    for (const child of node.childNodes.toReversed()) stack.push({ node: child, into, depth });
  }

  return nodes;
}

/** Normalize one token list; renderers normalize nested Markdown lists at their own boundary. */
export function normalizeHtmlTokens(tokens: Token[]): Token[] {
  if (!tokens.some((token) => token.type === "html")) return tokens;

  const html = tokens
    .flatMap((token) => (token.type === "html" ? [token.raw] : []))
    .join("")
    .toLowerCase();

  let marker = "canopy-markdown-token";

  // No input tag, attribute or comment can impersonate a trusted Markdown placeholder.
  while (html.includes(marker)) marker += "x";

  const source = tokens
    .map((token, index) => (token.type === "html" ? token.raw : `<${marker} data-index="${index}"></${marker}>`))
    .join("");

  const nodes = htmlNodes(parseFragment(source).childNodes, marker, tokens);
  const normalized: Token[] = [];
  let pending: HtmlToken | undefined;

  for (const node of nodes) {
    if (node.kind === "markdown") {
      pending = undefined;
      normalized.push(node.token);
    } else {
      if (!pending) {
        pending = { type: "safeHtml", raw: "", nodes: [] };
        normalized.push(pending);
      }

      pending.nodes.push(node);
    }
  }

  return normalized;
}
