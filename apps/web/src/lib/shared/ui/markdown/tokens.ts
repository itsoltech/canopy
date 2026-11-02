import { Lexer, type Token, type Tokens } from "marked";

/** `breaks`: a single newline is a line break (people's messages), not a soft wrap (agents' markdown). */
export const lexMarkdown = (text: string, breaks = false): Token[] => Lexer.lex(text, { gfm: true, breaks });

/**
 * The new token tree with every block, list item and table row that did not change replaced by the
 * previous object. Svelte's `{#each}` skips items that are the same object, so while a message
 * streams only the block that grew renders again (and inside a list or table, only the item or row).
 */
export function shareTokens(previous: readonly Token[], next: Token[]): Token[] {
  return next.map((token, index) => {
    const before = previous[index];
    return before ? share(before, token) : token;
  });
}

function share(before: Token, after: Token): Token {
  if (before.type !== after.type) return after;
  // A list item's looseness comes from its list, not from its own source.
  if (before.raw === after.raw && looseOf(before) === looseOf(after)) return before;
  if (after.type === "list" && before.type === "list") {
    (after as Tokens.List).items = shareTokens((before as Tokens.List).items, (after as Tokens.List).items) as Tokens.ListItem[];
  } else if (after.type === "table" && before.type === "table") {
    const rows = (before as Tokens.Table).rows;
    (after as Tokens.Table).rows = (after as Tokens.Table).rows.map((row, index) => {
      const old = rows[index];
      return old && old.length === row.length && old.every((cell, cellIndex) => cell.text === row[cellIndex]?.text) ? old : row;
    });
  }
  if ("tokens" in after && Array.isArray(after.tokens) && "tokens" in before && Array.isArray(before.tokens)) {
    after.tokens = shareTokens(before.tokens, after.tokens);
  }
  return after;
}

const looseOf = (token: Token): boolean | undefined => ("loose" in token ? Boolean(token.loose) : undefined);
