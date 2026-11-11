import type { Token } from "marked";
import { lexMarkdown } from "@canopy/domain/markdown";
import { shareTokens } from "./tokens.ts";

/**
 * Re-lex the last block, including its trailing space: lists, tables, fences and setext headings can
 * still grow or change kind. Earlier blocks are independent unless reference syntax is present.
 * References, carriage-return normalization, edits and option changes use the full lexer.
 */
export class StreamingTokens {
  #text = "";
  #breaks = false;
  #tokens: Token[] = [];
  #offset = 0;
  #count = 0;

  update(text: string, breaks = false): Token[] {
    if (text === this.#text && breaks === this.#breaks) return this.#tokens;
    const independent = !text.includes("[") && !text.includes("\r");
    const append = independent && breaks === this.#breaks && text.startsWith(this.#text);
    const offset = append ? this.#offset : 0;
    const count = append ? this.#count : 0;
    const tail = lexMarkdown(text.slice(offset), breaks);
    // A later definition may change a link inside an otherwise identical raw block.
    const shared = independent && breaks === this.#breaks ? shareTokens(this.#tokens.slice(count), tail) : tail;
    this.#tokens = [...this.#tokens.slice(0, count), ...shared];
    this.#text = text;
    this.#breaks = breaks;

    let last = this.#tokens.length - 1;

    while (last > 0 && this.#tokens[last]?.type === "space") last--;
    this.#count = Math.max(0, last);
    this.#offset = offset;

    for (let i = count; i < this.#count; i++) this.#offset += this.#tokens[i]!.raw.length;

    return this.#tokens;
  }
}
