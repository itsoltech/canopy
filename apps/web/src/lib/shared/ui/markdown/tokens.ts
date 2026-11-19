import type { Token } from "marked";
import { isToken } from "@canopy/domain/markdown";

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

const looseOf = (token: Token): boolean | undefined => ("loose" in token ? Boolean(token.loose) : undefined);
