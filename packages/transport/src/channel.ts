/**
 * Async queue exposed as a single-consumer AsyncIterable. Optional bounds fail one slow reader.
 * Turns push-style producers into the AsyncIterable shape Connect streams expect.
 * Every [Symbol.asyncIterator]() call returns the same generator, which Connect relies on
 * (it also needs the full generator protocol: next/return/throw).
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  readonly #buffer: { value: T; bytes: number }[] = [];
  readonly #iterator: AsyncGenerator<T, void, undefined> = this.#drain();
  #wake: (() => void) | undefined;
  #closed = false;
  #error: unknown;
  #bytes = 0;
  constructor(
    readonly limits?: { maxItems: number; maxBytes?: number; sizeOf?: (value: T) => number; overflow: () => Error },
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  /** Returns false when the channel is already closed and the value was dropped. */
  push(value: T, size?: number): boolean {
    if (this.#closed) return false;
    const bytes = size ?? this.limits?.sizeOf?.(value) ?? 1;

    if (
      this.limits &&
      (this.#buffer.length >= this.limits.maxItems || this.#bytes + bytes > (this.limits.maxBytes ?? Infinity))
    ) {
      this.#buffer.length = 0;
      this.#bytes = 0;
      this.close(this.limits.overflow());

      return false;
    }

    this.#buffer.push({ value, bytes });
    this.#bytes += bytes;
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
          const entry = this.#buffer.shift()!;
          this.#bytes -= entry.bytes;
          yield entry.value;
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
      this.#bytes = 0;
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
