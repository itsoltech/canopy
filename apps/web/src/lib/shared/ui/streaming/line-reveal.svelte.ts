import { streamingText } from "@canopy/ui/streaming";

/**
 * The shown part of a streaming text (agent message, reasoning, command output): it advances a line at
 * a time. A partial last line stays buffered until streaming stops (the item completed or its turn ended),
 * which prevents the renderer from changing on every token. `text` stays the full value, exact once
 * streaming stops.
 */
export class LineReveal {
  readonly #source: () => string;
  readonly #streaming: () => boolean;

  readonly text: string = $derived(streamingText(this.#source(), this.#streaming()));

  constructor(source: () => string, streaming: () => boolean) {
    this.#source = source;
    this.#streaming = streaming;
  }
}
