/**
 * Unbounded async queue exposed as a single-consumer AsyncIterable.
 * Turns push-style producers into the AsyncIterable shape Connect streams expect.
 * Every [Symbol.asyncIterator]() call returns the same generator, which Connect relies on
 * (it also needs the full generator protocol: next/return/throw).
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  readonly #iterator: AsyncGenerator<T, void, undefined> = this.#drain();
  #wake: (() => void) | undefined;
  #closed = false;
  #error: unknown;

  get closed(): boolean {
    return this.#closed;
  }

  /** Returns false when the channel is already closed and the value was dropped. */
  push(value: T): boolean {
    if (this.#closed) return false;
    this.#buffer.push(value);
    this.#notify();

    return true;
  }

  /** Ends the stream. Buffered values are still delivered, then `cause` is thrown if given. */
  close(cause?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = cause;
    this.#notify();
  }

  [Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    return this.#iterator;
  }

  async *#drain(): AsyncGenerator<T, void, undefined> {
    try {
      for (;;) {
        if (this.#buffer.length > 0) {
          // SAFETY: the buffer is not empty, so shift() returns one of its values (which may itself be undefined).
          yield this.#buffer.shift() as T;
        } else if (this.#closed) {
          if (this.#error !== undefined) throw this.#error;

          return;
        } else {
          await new Promise<void>((resolve) => (this.#wake = resolve));
        }
      }
    } finally {
      // Consumer stopped early (break/return/throw): drop the rest and refuse new values.
      this.#closed = true;
      this.#buffer.length = 0;
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
