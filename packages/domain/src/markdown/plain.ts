import type { Token } from "marked";
import { isToken, lexMarkdown } from "./lex.ts";
import { isMathToken } from "./math.ts";

/** Visible message text for a whole-message reply, preserving code and line breaks. */
export function markdownText(text: string): string {
  return plainTokens(lexMarkdown(text)).trim();
}

function plainTokens(tokens: readonly Token[]): string {
  return tokens.map(plainToken).join("");
}

function plainToken(token: Token): string {
  if (isToken(token, "paragraph") || isToken(token, "heading")) return `${plainTokens(token.tokens)}\n\n`;

  if (isToken(token, "blockquote")) return `${plainTokens(token.tokens)}\n`;

  if (isToken(token, "strong") || isToken(token, "em") || isToken(token, "del") || isToken(token, "link"))
    return plainTokens(token.tokens);

  if (isToken(token, "text")) return token.tokens ? plainTokens(token.tokens) : token.text;

  if (isToken(token, "code")) return `${token.text}\n\n`;

  if (isToken(token, "codespan") || isToken(token, "escape") || isToken(token, "image")) return token.text;

  if (isToken(token, "list")) return `${token.items.map((item) => plainTokens(item.tokens).trim()).join("\n")}\n\n`;

  if (isToken(token, "table"))
    return `${[token.header, ...token.rows].map((row) => row.map((cell) => plainTokens(cell.tokens)).join("\t")).join("\n")}\n\n`;

  if (isMathToken(token)) return token.raw;

  if (token.type === "br" || token.type === "space") return "\n";

  if (token.type === "hr") return "\n\n";

  return token.raw;
}
