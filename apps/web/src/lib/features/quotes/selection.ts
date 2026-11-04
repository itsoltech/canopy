import type { QuoteSourceKind } from "@canopy/domain";

/**
 * What a selection in the transcript quotes: the text as the reader sees it (rendered markdown without its
 * `**`, code with its line breaks) and the item it came from. Agent-produced content marks itself:
 *
 *   data-quote-item="<item id>" data-quote-thread="<thread id>"   the item (ItemNodeView)
 *   data-quote-kind="agent_message|reasoning|…" data-quote-lang   a region of one kind inside it
 *
 * A selection quotes only when it stays inside one region of one item (one quote per selection; a selection
 * across items, or into your own messages or the UI around them, shows no Cite). The text walk works on any
 * node tree with this shape (the DOM, or plain objects in tests).
 */
export interface QuoteNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<QuoteNode>;
  getAttribute?(name: string): string | null;
}

const TEXT = 3;
const ELEMENT = 1;
const FRAGMENT = 11;

/** Never part of the visible text: controls and decoration inside a quotable region. */
const SKIPPED = new Set([
  "BUTTON",
  "SVG",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "IMG",
  "SUMMARY",
]);

/** Blocks set apart by an empty line (paragraph spacing); other blocks start a new line. */
const PARAGRAPHS = new Set([
  "P",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "TABLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "FIGURE",
]);

const BLOCKS = new Set([
  ...PARAGRAPHS,
  "DIV",
  "LI",
  "TR",
  "SECTION",
  "ARTICLE",
  "DETAILS",
  "DL",
  "DT",
  "DD",
  "HEADER",
  "FOOTER",
]);

const CELLS = new Set(["TD", "TH"]);

function skipped(node: QuoteNode): boolean {
  if (SKIPPED.has(node.nodeName.toUpperCase())) return true;
  const attr = (name: string) => node.getAttribute?.(name) ?? null;

  return attr("aria-hidden") === "true" || attr("data-quote-skip") !== null || attr("hidden") !== null;
}

/** An element whose whitespace shows as typed: `<pre>` and the code surfaces (diff lines). */
export function isPreformatted(node: QuoteNode): boolean {
  if (node.nodeName.toUpperCase() === "PRE") return true;
  const classes = node.getAttribute?.("class") ?? "";

  return /(^|\s)code-surface(\s|$)/.test(classes);
}

/**
 * The visible text of a node tree (a selection's cloned contents). `pre`: the tree starts inside preformatted
 * text (the selection lies within a code block), so its whitespace is kept as is.
 */
export function visibleText(root: QuoteNode, pre = false): string {
  // Pieces with break markers: "\n" = line break, "\n\n" = paragraph break (merged, never doubled).
  const out: string[] = [];

  const brk = (kind: "\n" | "\n\n") => {
    const last = out.at(-1);

    if (last === undefined) return; // no break before any text

    if (last === "\n" || last === "\n\n") out[out.length - 1] = last === "\n\n" || kind === "\n\n" ? "\n\n" : "\n";
    else out.push(kind);
  };

  const walk = (node: QuoteNode, inPre: boolean, row: { cell: boolean }) => {
    if (node.nodeType === TEXT) {
      const value = node.nodeValue ?? "";

      if (!value) return;

      if (inPre) out.push(value);
      else {
        const collapsed = value.replace(/[\t\n\r ]+/g, " ");
        const last = out.at(-1) ?? "";

        // Collapsed whitespace at a line start or after a space is not visible.
        const trimmed =
          last === "" || last.endsWith("\n") || last.endsWith(" ") ? collapsed.replace(/^ /, "") : collapsed;

        if (trimmed) out.push(trimmed);
      }

      return;
    }

    if (node.nodeType !== ELEMENT && node.nodeType !== FRAGMENT) return;

    if (node.nodeType === ELEMENT && skipped(node)) return;
    const name = node.nodeName.toUpperCase();

    if (name === "BR") {
      out.push("\n");

      return;
    }

    const childPre = inPre || (node.nodeType === ELEMENT && isPreformatted(node));
    const paragraph = PARAGRAPHS.has(name);
    const block = BLOCKS.has(name);

    if (paragraph) brk("\n\n");
    else if (block) brk("\n");

    if (CELLS.has(name)) {
      if (row.cell) out.push("\t");
      row.cell = true;
    }

    const childRow = name === "TR" ? { cell: false } : row;

    for (const child of Array.from(node.childNodes)) walk(child, childPre, childRow);

    if (paragraph) brk("\n\n");
    else if (block) brk("\n");
  };

  walk(root, pre, { cell: false });

  return tidy(out.join(""));
}

/** No trailing whitespace on lines (it does not show), at most one empty line in a row, no breaks at the ends. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

export interface QuoteSource {
  readonly itemId: string;
  readonly threadId: string;
  readonly kind: QuoteSourceKind;
  readonly language: string;
}

const KINDS = new Set<string>(["agent_message", "reasoning", "command_output", "tool_call", "code", "diff"]);

/**
 * Where a selection quotes from, from the element around both of its ends (the range's common ancestor): the
 * nearest quotable region, which must belong to the nearest item around it. Undefined = no Cite here.
 */
export function quoteSourceOf(element: Element | null): QuoteSource | undefined {
  const region = element?.closest<HTMLElement>("[data-quote-kind]");
  const item = element?.closest<HTMLElement>("[data-quote-item]");

  if (!region || !item || !item.contains(region) || region.closest("[data-quote-item]") !== item) return undefined;
  const kind = region.dataset.quoteKind ?? "";

  if (!KINDS.has(kind)) return undefined;

  return {
    itemId: item.dataset.quoteItem ?? "",
    threadId: item.dataset.quoteThread ?? "",
    kind: kind as QuoteSourceKind,
    language: region.dataset.quoteLang ?? "",
  };
}

export interface SelectedQuote {
  readonly text: string;
  readonly source: QuoteSource;
  /** The selection's line boxes (viewport px): the Cite button sits at its end. */
  readonly rects: readonly DOMRect[];
  /** The selection was made from its end back to its start (the caret is at the first line). */
  readonly backward: boolean;
}

/** The current selection as a quote, or undefined when it is empty or not inside one quotable region. */
export function selectedQuote(selection: Selection | null): SelectedQuote | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return undefined;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const element = common.nodeType === TEXT ? common.parentElement : (common as Element);
  const source = quoteSourceOf(element);

  if (!source || !element) return undefined;
  const pre = element.closest("pre, .code-surface") !== null;
  const text = visibleText(range.cloneContents(), pre);

  if (!text.trim()) return undefined;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  const anchor = selection.anchorNode;

  const backward =
    anchor !== null &&
    selection.focusNode !== null &&
    (anchor === selection.focusNode
      ? selection.focusOffset < selection.anchorOffset
      : (anchor.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_PRECEDING) !== 0);

  return { text, source, rects, backward };
}
