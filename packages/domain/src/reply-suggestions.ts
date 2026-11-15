import type { Token } from "marked";
import { isToken, lexMarkdown } from "./markdown/lex.ts";

const destination = "canopy:reply";

/** A reply is plain text; quoted examples, code, rich links and nested markup never become actions. */
function paragraphReplies(token: Token): string[] | undefined {
  if (!isToken(token, "paragraph")) return undefined;
  const replies: string[] = [];

  for (const part of token.tokens) {
    if (isToken(part, "text") && !part.text.trim()) continue;

    if (!isToken(part, "link") || part.href !== destination || part.title) return undefined;
    const text: string[] = [];

    for (const label of part.tokens) {
      if (isToken(label, "text") && !label.tokens) text.push(label.text);
      else if (isToken(label, "escape")) text.push(label.text);
      else return undefined;
    }

    const reply = text.join("");

    if (
      !reply.trim() ||
      reply !== reply.trim() ||
      reply.length > 500 ||
      /\p{Cc}/u.test(reply) ||
      reply.startsWith("!") ||
      /^\/goal(?:\s|$)/i.test(reply)
    )
      return undefined;
    replies.push(reply);
  }

  return replies.length ? replies : undefined;
}

/** Only trailing top-level link paragraphs are suggestions. The stored transcript stays unchanged. */
export function splitReplySuggestions(text: string) {
  if (!text.includes(destination)) return { text, replies: [] };
  const tokens = lexMarkdown(text);
  let start = tokens.length;
  const replies: string[] = [];

  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];

    if (!token || token.type === "space") continue;
    const found = paragraphReplies(token);

    if (!found) break;
    replies.unshift(...found);
    start = index;
  }

  if (!replies.length || replies.length > 3 || new Set(replies).size !== replies.length) return { text, replies: [] };

  const source = text.replace(/\r\n?/g, "\n");

  const suffix = tokens
    .slice(start)
    .map((token) => token.raw)
    .join("");

  if (!source.endsWith(suffix)) return { text, replies: [] };

  return { text: source.slice(0, source.length - suffix.length).trimEnd(), replies };
}
