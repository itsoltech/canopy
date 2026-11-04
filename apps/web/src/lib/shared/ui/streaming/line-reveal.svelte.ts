import { untrack } from "svelte";
import { idleCut, LINE_IDLE_MS, lineCut } from "./line-buffer.ts";

/**
 * The shown part of a streaming text (agent message, reasoning, command output): it advances a line at
 * a time; a partial last line follows `LINE_IDLE_MS` after the last reveal (so a long line or a short
 * one-line answer does not wait for its line break), and everything shows at once when streaming stops
 * (the item completed or its turn ended). `text` stays the full value, exact once streaming stops.
 *
 * `text` only changes when the shown part does, so what renders it (markdown) re-runs per line.
 * Create it during component initialisation (it owns an effect for the idle timer).
 */
export class LineReveal {
  /** Characters revealed beyond the last line break by an idle flush. */
  #revealed = $state(0);
  readonly #source: () => string;
  readonly #streaming: () => boolean;

  readonly text: string = $derived.by(() => {
    const source = this.#source();

    return this.#streaming() ? source.slice(0, lineCut(source, this.#revealed)) : source;
  });

  constructor(source: () => string, streaming: () => boolean, idleMs = LINE_IDLE_MS) {
    this.#source = source;
    this.#streaming = streaming;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown = "";
    $effect(() => {
      const pending = this.#streaming() && this.text.length < this.#source().length;

      // The idle pause counts from the last reveal.
      if (!pending || this.text !== shown) {
        clearTimeout(timer);
        timer = undefined;
        shown = this.text;
      }

      if (!pending) return;
      timer ??= setTimeout(() => {
        timer = undefined;
        untrack(() => (this.#revealed = idleCut(this.#source(), this.text.length)));
      }, idleMs);
    });
    $effect(() => () => clearTimeout(timer));
  }
}
