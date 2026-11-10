/** Keep complete groups of lines immutable; only the trailing group changes during an append. */
export class OutputChunks {
  #source = "";
  #sealed: string[] = [];
  #offset = 0;
  #chunks: readonly string[] = [];

  update(text: string): readonly string[] {
    if (text === this.#source) return this.#chunks;

    if (!text.startsWith(this.#source)) {
      this.#sealed = [];
      this.#offset = 0;
    }

    this.#source = text;
    let start = this.#offset;
    let cursor = start;
    let lines = 0;

    while ((cursor = text.indexOf("\n", cursor)) !== -1) {
      cursor++;

      if (++lines === 32) {
        this.#sealed.push(text.slice(start, cursor));
        start = cursor;
        lines = 0;
      }
    }

    this.#offset = start;
    this.#chunks = start < text.length ? [...this.#sealed, text.slice(start)] : [...this.#sealed];

    return this.#chunks;
  }
}
