/** A run of a line with one colour; no `color` is the default text colour. */
export interface CodeToken {
  readonly content: string;
  readonly color?: string;
}

export interface HighlightedLine {
  readonly text: string;
  readonly tokens: readonly CodeToken[];
}

/**
 * Tokenizes one line (no line break) starting from the grammar state after the previous line (undefined
 * for the first) and returns the state after it. The state is opaque here (Shiki's `GrammarState`).
 */
export type LineTokenizer = (text: string, state: unknown) => { tokens: CodeToken[]; state: unknown };

/**
 * Highlighting of a text that grows line by line. It keeps the tokens and the grammar state after every
 * line, so new lines continue from where the last one ended and lines that did not change keep their
 * objects (and their DOM): while a block streams only the last line, which may have been partial, is
 * tokenized again.
 */
export class IncrementalHighlight {
  /** The highlighted prefix of the source, line by line. */
  readonly lines: HighlightedLine[] = [];
  readonly #states: unknown[] = [];

  /** Drops the highlighted lines from the first one that differs from `source`; true when any were dropped. */
  retain(source: readonly string[]): boolean {
    let same = 0;

    while (same < this.lines.length && same < source.length && this.lines[same]?.text === source[same]) same++;

    if (same === this.lines.length) return false;
    this.lines.length = same;
    this.#states.length = same;

    return true;
  }

  /** Highlights the next lines of `source` while `more()` allows (at least one); true when all of them are. */
  advance(source: readonly string[], tokenize: LineTokenizer, more: () => boolean = () => true): boolean {
    this.retain(source);

    while (this.lines.length < source.length) {
      const index = this.lines.length;
      const text = source[index] ?? "";
      const { tokens, state } = tokenize(text, this.#states[index - 1]);
      this.lines.push({ text, tokens });
      this.#states.push(state);

      if (!more()) break;
    }

    return this.lines.length === source.length;
  }
}
