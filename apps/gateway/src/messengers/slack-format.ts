import { isToken, lexMarkdown, safeHref } from "@canopy/domain/markdown";

type MarkdownToken = ReturnType<typeof lexMarkdown>[number];

type Style = Partial<Record<"bold" | "italic" | "strike" | "code", true>>;

type Inline =
  | { type: "text"; text: string; style?: Style }
  | { type: "link"; url: string; text: string; style?: Style }
  | { type: "user"; user_id: string };

interface Section {
  type: "rich_text_section";
  elements: Inline[];
}

type Element =
  | Section
  | { type: "rich_text_quote" | "rich_text_preformatted"; elements: Inline[] }
  | { type: "rich_text_list"; style: "bullet" | "ordered"; indent: number; offset?: number; elements: Section[] };

const text = (value: string, style?: Style): Inline => ({ type: "text", text: value, ...(style && { style }) });
const section = (elements: Inline[]): Section => ({ type: "rich_text_section", elements });
const inlineText = (item: Inline) => (item.type === "user" ? `@${item.user_id}` : item.text);

function textWithMentions(value: string, style?: Style): Inline[] {
  const elements: Inline[] = [];
  let end = 0;

  // Only explicit individual mentions are active. Raw Slack broadcasts and group mentions stay text.
  for (const match of value.matchAll(/<@([UW][A-Z0-9]{1,79})>/g)) {
    const userId = match[1];

    if (userId === undefined) continue;

    if (match.index > end) elements.push(text(value.slice(end, match.index), style));
    elements.push({ type: "user", user_id: userId });
    end = match.index + match[0].length;
  }

  if (end < value.length) elements.push(text(value.slice(end), style));

  return elements;
}

function inline(tokens: readonly MarkdownToken[], mentions: boolean, style?: Style): Inline[] {
  return tokens.flatMap((token): Inline[] => {
    if (isToken(token, "strong")) return inline(token.tokens, mentions, { ...style, bold: true });

    if (isToken(token, "em")) return inline(token.tokens, mentions, { ...style, italic: true });

    if (isToken(token, "del")) return inline(token.tokens, mentions, { ...style, strike: true });

    if (isToken(token, "codespan") || isToken(token, "code")) return [text(token.text, { ...style, code: true })];

    if (isToken(token, "escape")) return [text(token.text, style)];

    if (isToken(token, "link") || isToken(token, "image")) {
      const url = safeHref(token.href);
      const label = inline(token.tokens, false).map(inlineText).join("") || token.text;

      return url ? [{ type: "link", url, text: label || url, ...(style && { style }) }] : [text(token.raw, style)];
    }

    if (isToken(token, "heading")) return inline(token.tokens, mentions, { ...style, bold: true });

    if (isToken(token, "paragraph")) return inline(token.tokens, mentions, style);

    if (isToken(token, "text")) {
      if (token.tokens) return inline(token.tokens, mentions, style);

      return mentions ? textWithMentions(token.text, style) : [text(token.text, style)];
    }

    if (token.type === "br") return [text("\n", style)];

    return [text(token.raw, style)];
  });
}

function listElements(list: Extract<MarkdownToken, { type: "list" }>, indent: number): Element[] {
  const result: Element[] = [];
  const start = list.start === "" ? 1 : list.start;
  let current: Extract<Element, { type: "rich_text_list" }> | undefined;

  for (const [index, item] of list.items.entries()) {
    if (!current) {
      const offset = start + index - 1;
      current = {
        type: "rich_text_list",
        style: list.ordered ? "ordered" : "bullet",
        indent,
        ...(list.ordered && offset !== 0 && { offset }),
        elements: [],
      };
      result.push(current);
    }

    const elements: Inline[] = [];
    current.elements.push(section(elements));
    let destination = elements;

    for (const token of item.tokens) {
      if (isToken(token, "list")) {
        result.push(...listElements(token, indent + 1));
        current = undefined;
        destination = [];
      } else {
        if (destination !== elements && !destination.length) result.push(section(destination));
        destination.push(...inline([token], true));
      }
    }

    if (!elements.length) elements.push(text(" "));
  }

  return result;
}

function renderBlock(token: MarkdownToken): Element[] {
  if (isToken(token, "list")) return listElements(token, 0);

  if (isToken(token, "code"))
    return token.text ? [{ type: "rich_text_preformatted", elements: [text(token.text)] }] : [];

  if (isToken(token, "blockquote")) {
    const elements = inline(token.tokens, false);

    return elements.length ? [{ type: "rich_text_quote", elements }] : [];
  }

  const elements = inline([token], true);

  return elements.length ? [section(elements)] : [];
}

function fallbackText(element: Element) {
  if (element.type === "rich_text_list")
    return element.elements
      .map((item, index) => {
        const marker = element.style === "ordered" ? `${(element.offset ?? 0) + index + 1}.` : "•";

        return `${"  ".repeat(element.indent)}${marker} ${item.elements.map(inlineText).join("")}`;
      })
      .join("\n");

  return element.elements.map(inlineText).join("");
}

export const escapeSlackText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function formatSlackMessage(source: string) {
  const elements: Element[] = [];
  let paragraphBreak = false;

  for (const token of lexMarkdown(source, true)) {
    if (token.type === "space") {
      paragraphBreak = true;
      continue;
    }

    const previous = elements.at(-1);
    const rendered = renderBlock(token);

    if (paragraphBreak && previous?.type === "rich_text_section" && rendered[0]?.type === "rich_text_section")
      previous.elements.push(text("\n"));
    elements.push(...rendered);
    paragraphBreak = false;
  }

  return {
    text: escapeSlackText(elements.map(fallbackText).join("\n").trim() || source),
    blocks: elements.length ? [{ type: "rich_text", elements }] : [],
  };
}
