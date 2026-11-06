import type { Token, Tokens } from "marked";
import { isToken, lexMarkdown } from "@canopy/domain/markdown";
import { isString } from "#lib/shared/json.ts";

/**
 * The new token tree with every block, list item and table row that did not change replaced by the
 * previous object. Svelte's `{#each}` skips items that are the same object, so while a message
 * streams only the block that grew renders again (and inside a list or table, only the item or row).
 */
export function shareTokens<T extends Token>(previous: readonly T[], next: T[]): T[] {
  return next.map((token, index) => {
    const before = previous[index];

    return before ? share(before, token) : token;
  });
}

function share<T extends Token>(before: T, after: T): T {
  if (before.type !== after.type) return after;

  // A list item's looseness comes from its list, not from its own source.
  if (before.raw === after.raw && looseOf(before) === looseOf(after)) return before;

  if (isToken(after, "list") && isToken(before, "list")) {
    after.items = shareTokens(before.items, after.items);
  } else if (isToken(after, "table") && isToken(before, "table")) {
    const rows = before.rows;
    after.rows = after.rows.map((row, index) => {
      const old = rows[index];

      return old && old.length === row.length && old.every((cell, cellIndex) => cell.text === row[cellIndex]?.text)
        ? old
        : row;
    });
  }

  if ("tokens" in after && Array.isArray(after.tokens) && "tokens" in before && Array.isArray(before.tokens)) {
    after.tokens = shareTokens(before.tokens, after.tokens);
  }

  return after;
}

const textToken = (raw: string, text = raw): Tokens.Text => ({ type: "text", raw, text });

const looseOf = (token: Token): boolean | undefined => ("loose" in token ? Boolean(token.loose) : undefined);

/**
 * A message as one run of inline tokens, for one-line or clamped previews (the last message of a subagent):
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
