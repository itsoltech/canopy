import { SyntaxRole, type SyntaxLine, type SyntaxSpan } from "@canopy/contracts";
import type { GrammarState } from "@shikijs/primitive";
import { tokenizer } from "./highlighter.ts";
import { languageOfPath } from "./languages.ts";
import type { LineTokenizer } from "./incremental.ts";
import { SourceIndex } from "./source.ts";

export interface SourceChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface HighlightWindow {
  readonly lines: SyntaxLine[];
  readonly incomplete: boolean;
  readonly reason: string;
}

const roles = new Map([
  ["var(--code-comment)", SyntaxRole.COMMENT],
  ["var(--code-keyword)", SyntaxRole.KEYWORD],
  ["var(--code-punctuation)", SyntaxRole.PUNCTUATION],
  ["var(--code-string)", SyntaxRole.STRING],
  ["var(--code-regexp)", SyntaxRole.REGEXP],
  ["var(--code-constant)", SyntaxRole.CONSTANT],
  ["var(--code-function)", SyntaxRole.FUNCTION],
  ["var(--code-type)", SyntaxRole.TYPE],
  ["var(--code-tag)", SyntaxRole.TAG],
  ["var(--code-property)", SyntaxRole.PROPERTY],
  ["var(--code-inserted)", SyntaxRole.INSERTED],
  ["var(--code-deleted)", SyntaxRole.DELETED],
]);

/** Lives exclusively in a CPU worker. The caller enforces a hard 100 ms execution deadline. */
export class WindowHighlighter {
  #tokenize: LineTokenizer | undefined;
  #index: SourceIndex;
  #blocked = Infinity;
  readonly #lines = new Map<number, SyntaxLine>();
  #bytes = 0;
  #next = 1;
  #state: GrammarState | undefined;
  readonly #states = new Map<number, GrammarState | undefined>([[1, undefined]]);

  constructor(
    readonly path: string,
    text: string,
  ) {
    this.#index = new SourceIndex(text);
  }

  async ready() {
    const language = languageOfPath(this.path);

    if (language) {
      this.#tokenize = await tokenizer(language, { timeLimitMs: 0 });
      // Native RegExp compiles on its first non-empty match. Warm common scanner states
      // with fixed input during initialization, never with untrusted file contents.
      this.#tokenize('const value = "text"; /* comment */ // comment', undefined);
    }
  }

  get lineCount(): number {
    return this.#index.lines;
  }

  change(changes: readonly SourceChange[]) {
    let text = this.#index.text;
    let earliest = Infinity;

    for (const change of changes.toReversed()) {
      if (change.from < 0 || change.to < change.from || change.to > text.length)
        throw new Error("Invalid source change");
      earliest = Math.min(earliest, this.#index.lineForOffset(change.from));
      text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    }

    this.#index = new SourceIndex(text);

    for (const line of this.#states.keys()) if (line > earliest) this.#states.delete(line);
    this.#next = 1;

    for (const line of this.#states.keys()) if (line <= earliest && line > this.#next) this.#next = line;
    this.#state = this.#states.get(this.#next);

    for (const [number, line] of this.#lines) {
      if (number < this.#next) continue;
      this.#bytes -= 32 + line.spans.length * 24;
      this.#lines.delete(number);
    }

    this.#blocked = Math.min(this.#blocked, earliest) === earliest ? Infinity : this.#blocked;
  }

  render(start: number, count: number): HighlightWindow {
    if (!this.#tokenize) return { lines: [], incomplete: false, reason: "No highlighting for this file type." };
    const lines: SyntaxLine[] = [];
    const end = Math.min(this.#index.lines + 1, start + Math.min(200, count));
    let next = this.#next;
    let state = this.#state;
    const deadline = performance.now() + 70;
    let bytes = 0;

    while (next < end && next < this.#blocked) {
      const { from, to } = this.#index.line(next);

      if (to - from > 2000) {
        this.#blocked = next;
        break;
      }

      const result = this.#tokenize(this.#index.text.slice(from, to), state);
      state = result.state;
      const spans = semanticSpans(result.tokens);
      const line: SyntaxLine = { $typeName: "canopy.worker.v1.SyntaxLine", line: next, spans };
      const cost = 32 + spans.length * 24;

      if (this.#bytes + cost > 8 * 1024 * 1024) {
        this.#blocked = next;
        break;
      }

      this.#bytes += cost;
      this.#lines.set(next, line);

      if (next >= start) {
        // Each span has three bounded varints; reserve protobuf envelopes and revision fields.
        bytes += 16 + spans.length * 18;

        if (bytes > 60 * 1024) {
          next++;
          break;
        }
      }

      next++;

      if (next % 32 === 1 || next === end || performance.now() >= deadline) this.#remember(next, state);

      if (performance.now() >= deadline) break;
    }

    this.#next = next;
    this.#state = state;
    this.#remember(next, state);

    bytes = 0;

    for (let number = start; number < end; number++) {
      const line = this.#lines.get(number);

      if (!line || bytes + 16 + line.spans.length * 18 > 60 * 1024) break;
      bytes += 16 + line.spans.length * 18;
      lines.push(line);
    }

    return {
      lines,
      incomplete: next < end,
      reason:
        this.#blocked < end
          ? "Highlighting stopped at the file’s preview limit. The remaining text is readable."
          : next < end
            ? "This window is shown as plain text while highlighting catches up."
            : "",
    };
  }

  #remember(line: number, state: GrammarState | undefined) {
    this.#states.delete(line);
    this.#states.set(line, state);

    while (this.#states.size > 128) {
      const first = [...this.#states.keys()].find((key) => key !== 1);

      if (first === undefined) break;
      this.#states.delete(first);
    }
  }
}

function semanticSpans(tokens: ReturnType<LineTokenizer>["tokens"]): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  let from = 0;

  for (const token of tokens) {
    const to = from + token.content.length;
    const role = roles.get(token.color ?? "");

    if (role && to > from) spans.push({ $typeName: "canopy.worker.v1.SyntaxSpan", from, to, role });
    from = to;
  }

  return spans;
}
