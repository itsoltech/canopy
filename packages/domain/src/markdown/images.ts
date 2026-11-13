import type { Token } from "marked";
import { isToken, lexMarkdown } from "./lex.ts";

export interface LocalMarkdownImage {
  readonly href: string;
  readonly path: string;
  readonly alt: string;
  readonly start: number;
  readonly end: number;
}

/** Local explicit paths only. No scheme, network path, traversal, or implicit file search. */
export function localImagePath(href: string): string | undefined {
  if (
    !href ||
    href.includes("\0") ||
    href.includes("\r") ||
    href.includes("\n") ||
    (/^(?:[a-z][\w+.-]*:|[/\\]{2})/i.test(href) && !/^[a-z]:[/\\]/i.test(href))
  )
    return;
  let path: string;

  try {
    path = decodeURIComponent(href);
  } catch {
    return;
  }

  if (
    path.includes("\0") ||
    path.includes("\r") ||
    path.includes("\n") ||
    path.split(/[/\\]/).includes("..") ||
    /^[/\\]{2}/.test(path)
  )
    return;

  if (/^[a-z][\w+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path)) return;

  return path;
}

/** Locate actual parsed image tokens, advancing over code before searching a following sibling. */
export function localMarkdownImages(text: string): LocalMarkdownImage[] {
  const images: LocalMarkdownImage[] = [];

  const walk = (tokens: readonly Token[], start: number, end: number) => {
    let cursor = start;

    for (const token of tokens) {
      const at = text.indexOf(token.raw, cursor);

      // Some indentation-normalized nested tokens cannot be mapped exactly. Fail closed.
      if (at < cursor || at + token.raw.length > end) continue;
      cursor = at + token.raw.length;

      if (isToken(token, "image")) {
        const path = localImagePath(token.href);

        if (path)
          images.push({ href: token.href, path, alt: (token.text || path).slice(0, 300), start: at, end: cursor });
      } else if (isToken(token, "list")) walk(token.items, at, cursor);
      else if (isToken(token, "table")) {
        const cells = [...token.header, ...token.rows.flat()];
        walk(
          cells.flatMap((cell) => cell.tokens),
          at,
          cursor,
        );
      } else if (
        token.type !== "code" &&
        token.type !== "codespan" &&
        token.type !== "html" &&
        "tokens" in token &&
        token.tokens
      ) {
        walk(token.tokens, at, cursor);
      }
    }
  };

  walk(lexMarkdown(text), 0, text.length);

  return images;
}
