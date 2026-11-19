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
  #fixedPrefix = 0;
  readonly #writers = new Set<() => void>();
  constructor(
    readonly limits?: {
      maxItems: number;
      maxBytes?: number;
      reservedItems?: number;
      sizeOf?: (value: T) => number;
      /** At capacity, return discardable indices and the count of input entries sealed against future pushes. */
      compact?: (pending: readonly T[]) => { removed: ReadonlySet<number>; fixedPrefix: number };
      overflow: () => Error;
    },
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  get queuedItems(): number {
    return this.#buffer.length;
  }
  get queuedBytes(): number {
    return this.#bytes;
  }

  /** Returns false on overflow or if the channel is already closed. */
  push(value: T, size?: number): boolean {
    if (this.#closed) return false;
    const bytes = size ?? this.limits?.sizeOf?.(value) ?? 1;

    if (
      this.limits &&
      (this.#buffer.length >= this.limits.maxItems || this.#bytes + bytes > (this.limits.maxBytes ?? Infinity))
    ) {
      if (!this.#compact(value, bytes)) {
        this.#buffer.length = 0;
        this.#bytes = 0;
        this.close(this.limits.overflow());

        return false;
      }
    } else {
      this.#buffer.push({ value, bytes });
      this.#bytes += bytes;
    }

    this.#notify();

    return true;
  }

  #compact(value: T, bytes: number): boolean {
    if (!this.limits?.compact || bytes > (this.limits.maxBytes ?? Infinity)) return false;
    const suffix = this.#buffer.slice(this.#fixedPrefix);
    suffix.push({ value, bytes });
    const { removed, fixedPrefix } = this.limits.compact(suffix.map((entry) => entry.value));

    if (!removed.size) return false;
    this.#bytes += bytes;
    let kept = this.#fixedPrefix;

    for (const [index, entry] of suffix.entries()) {
      if (removed.has(index)) this.#bytes -= entry.bytes;
      else {
        this.#buffer[kept++] = entry;

        if (index < fixedPrefix) this.#fixedPrefix++;
      }
    }

    this.#buffer.length = kept;
    this.#resumeWriters();

    return kept <= this.limits.maxItems && this.#bytes <= (this.limits.maxBytes ?? Infinity);
  }

  /** Lossless producers wait for capacity. Reserved slots remain available to synchronous control frames. */
  async write(value: T, signal: AbortSignal, size?: number): Promise<boolean> {
    const bytes = size ?? this.limits?.sizeOf?.(value) ?? 1;

    if (this.limits && bytes > (this.limits.maxBytes ?? Infinity)) throw this.limits.overflow();

    while (!this.#closed) {
      signal.throwIfAborted();

      if (
        !this.limits ||
        (this.#buffer.length < this.limits.maxItems - (this.limits.reservedItems ?? 0) &&
          this.#bytes + bytes <= (this.limits.maxBytes ?? Infinity))
      )
        return this.push(value, bytes);

      await new Promise<void>((resolve) => {
        const resume = () => {
          this.#writers.delete(resume);
          signal.removeEventListener("abort", resume);
          resolve();
        };

        this.#writers.add(resume);
        signal.addEventListener("abort", resume, { once: true });
      });
    }

    return false;
  }

  /** Ends the stream. Buffered values are still delivered, then `cause` is thrown if given. */
  close(cause?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = cause;
    this.#notify();
    this.#resumeWriters();
  }

  [Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    return this.#iterator;
  }

  /** Let the single consumer take an already buffered matching head without waiting for another write. */
  takeIf(matches: (value: T) => boolean): T | undefined {
    const head = this.#buffer[0];

    if (!head || !matches(head.value)) return;

    return this.#shift();
  }

  #shift(): T {
    const entry = this.#buffer.shift()!;
    this.#bytes -= entry.bytes;

    if (this.#fixedPrefix) this.#fixedPrefix--;
    this.#resumeWriters();

    return entry.value;
  }

  async *#drain(): AsyncGenerator<T, void, undefined> {
    try {
      for (;;) {
        if (this.#buffer.length > 0) {
          yield this.#shift();
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
      this.#resumeWriters();
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #resumeWriters(): void {
    for (const resume of this.#writers) resume();
  }
}
