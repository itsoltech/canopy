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

/**
 * A message as one run of inline tokens, for one-line or clamped previews (the last message of a subagent):
 * blocks flatten into their inline content separated by spaces, code blocks become their first line as inline
 * code, links keep only their text (previews sit inside links) and images their alt text.
 */
export function snippetTokens(text: string): Token[] {
  const out: Token[] = [];
  const space = (): void => {
    if (out.length > 0) out.push({ type: "text", raw: " ", text: " " } as Tokens.Text);
  };
  const inline = (tokens: Token[] | undefined): Token[] =>
    (tokens ?? []).flatMap((token): Token[] => {
      if (token.type === "link") return inline((token as Tokens.Link).tokens);
      if (token.type === "image") return [{ type: "text", raw: token.raw, text: (token as Tokens.Image).text } as Tokens.Text];
      if (token.type === "br") return [{ type: "text", raw: " ", text: " " } as Tokens.Text];
      if ("tokens" in token && Array.isArray(token.tokens)) return [{ ...token, tokens: inline(token.tokens) } as Token];
      return [token];
    });
  const walk = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (token.type === "space" || token.type === "hr" || token.type === "html") continue;
      if (token.type === "code") {
        const first = (token as Tokens.Code).text.split("\n").find((line) => line.trim()) ?? "";
        if (first) {
          space();
          out.push({ type: "codespan", raw: first, text: first.trim() } as Tokens.Codespan);
        }
      } else if (token.type === "list") {
        for (const item of (token as Tokens.List).items) walk(item.tokens);
      } else if (token.type === "blockquote") {
        walk((token as Tokens.Blockquote).tokens);
      } else if (token.type === "table") {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows]) for (const cell of row) {
          space();
          out.push(...inline(cell.tokens));
        }
      } else if ("tokens" in token && Array.isArray(token.tokens)) {
        space();
        out.push(...inline(token.tokens));
      } else if ("text" in token && typeof token.text === "string") {
        space();
        out.push({ type: "text", raw: token.text, text: token.text } as Tokens.Text);
      }
    }
  };
  walk(lexMarkdown(text));
  return out;
}
