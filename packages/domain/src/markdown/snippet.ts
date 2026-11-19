import type { Token, Tokens } from "marked";
import { isString } from "../json.ts";
import { isToken, lexMarkdown } from "./lex.ts";

const textToken = (raw: string, text = raw): Tokens.Text => ({ type: "text", raw, text });

/**
 * A message as one run of inline tokens, for one-line or clamped previews:
 * blocks flatten into their inline content separated by spaces, code blocks become their first line as inline
 * code, links keep only their text (previews sit inside links) and images their alt text.
 */
export function snippetTokens(text: string): Token[] {
  const out: Token[] = [];

  const space = (): void => {
    if (out.length > 0) out.push(textToken(" "));
  };

  const inline = (tokens: Token[] | undefined): Token[] =>
    (tokens ?? []).flatMap((token): Token[] => {
      if (isToken(token, "link")) return inline(token.tokens);

      if (isToken(token, "image")) return [textToken(token.raw, token.text)];

      if (token.type === "br") return [textToken(" ")];

      if ("tokens" in token && Array.isArray(token.tokens)) return [{ ...token, tokens: inline(token.tokens) }];

      return [token];
    });

  const walk = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (token.type === "space" || token.type === "hr" || token.type === "html") continue;

      if (isToken(token, "code")) {
        const first = token.text.split("\n").find((line) => line.trim()) ?? "";

        if (first) {
          space();
          out.push({ type: "codespan", raw: first, text: first.trim() } satisfies Tokens.Codespan);
        }
      } else if (isToken(token, "list")) {
        for (const item of token.items) walk(item.tokens);
      } else if (isToken(token, "blockquote")) {
        walk(token.tokens);
      } else if (isToken(token, "table")) {
        const table = token;

        for (const row of [table.header, ...table.rows])
          for (const cell of row) {
            space();
            out.push(...inline(cell.tokens));
          }
      } else if ("tokens" in token && Array.isArray(token.tokens)) {
        space();
        out.push(...inline(token.tokens));
      } else if ("text" in token && isString(token.text)) {
        space();
        out.push(textToken(token.text));
      }
    }
  };

  walk(lexMarkdown(text));

  return out;
}
