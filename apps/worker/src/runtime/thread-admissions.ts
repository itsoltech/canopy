import { CommandError } from "./host-types.ts";

/** Archive and rewind invalidate queued work immediately and drain preparation before releasing a session. */
export class ThreadAdmissions {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #generations = new Map<string, number>();

  current(threadId: string): () => boolean {
    const generation = this.#generations.get(threadId) ?? 0;

    return () => (this.#generations.get(threadId) ?? 0) === generation;
  }

  async start<A>(threadId: string, run: (current: () => boolean) => Promise<A>): Promise<A> {
    const current = this.current(threadId);
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => run(current));

    const settled = next.then(
      () => {},
      () => {},
    );

    this.#tails.set(threadId, settled);

    try {
      return await next;
    } finally {
      if (this.#tails.get(threadId) === settled) this.#tails.delete(threadId);
    }
  }

  invalidate(threadId: string): void {
    this.#generations.set(threadId, (this.#generations.get(threadId) ?? 0) + 1);
  }

  async drain(threadId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.#tails.get(threadId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CommandError("REWIND_BUSY", "The agent is still stopping. Try editing again.", true)),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
