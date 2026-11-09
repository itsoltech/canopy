import type { Token } from "marked";
import { isToken, lexMarkdown } from "@canopy/domain/markdown";

function plain(token: Token): string {
  if (isToken(token, "list")) return token.items.map((item) => item.tokens.map(plain).join("")).join("\n") + "\n";

  if (isToken(token, "table"))
    return (
      [token.header, ...token.rows]
        .map((row) => row.map((cell) => cell.tokens.map(plain).join("")).join("\t"))
        .join("\n") + "\n"
    );

  if (isToken(token, "heading") || isToken(token, "paragraph")) return token.tokens.map(plain).join("") + "\n";

  if (isToken(token, "blockquote")) return token.tokens.map(plain).join("");

  if (isToken(token, "strong") || isToken(token, "em") || isToken(token, "del") || isToken(token, "link"))
    return token.tokens.map(plain).join("");

  if (isToken(token, "text") && token.tokens) return token.tokens.map(plain).join("");

  if (isToken(token, "text") || isToken(token, "codespan") || isToken(token, "escape") || isToken(token, "image"))
    return token.text;

  if (isToken(token, "code")) return token.text + "\n";

  if (token.type === "space" || token.type === "br" || token.type === "hr") return "\n";

  return token.raw;
}

/** Quotes contain the visible words and code, without Markdown delimiters or link destinations. */
export const markdownText = (text: string) => lexMarkdown(text).map(plain).join("").trim();
