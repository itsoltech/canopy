import type { PromptEvent } from "./types.ts";

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export class EventStream implements AsyncIterable<PromptEvent> {
  readonly #queue: PromptEvent[] = [];
  #wake: (() => void) | undefined;
  #done = false;
  #error: Error | undefined;
  constructor(
    readonly limit: number,
    readonly overflow: (error: Error) => void,
  ) {}
  push(event: PromptEvent): void {
    if (this.#done) return;

    if (this.#queue.length >= this.limit) {
      const error = new AcpError("ACP event consumer fell behind");
      this.end(error);
      this.overflow(error);

      return;
    }

    this.#queue.push(event);
    this.#wake?.();
  }
  end(error?: Error): void {
    this.#done = true;
    this.#error = error;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<PromptEvent> {
    for (;;) {
      const next = this.#queue.shift();

      if (next) {
        yield next;
        continue;
      }

      if (this.#error) throw this.#error;

      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}
