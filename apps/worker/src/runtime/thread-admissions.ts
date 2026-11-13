import { CommandError } from "./host-types.ts";

/** A rewind invalidates queued starts immediately and drains preparation before replacing the session. */
export class ThreadAdmissions {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #generations = new Map<string, number>();

  async start<A>(threadId: string, run: (current: () => boolean) => Promise<A>): Promise<A> {
    const generation = this.#generations.get(threadId) ?? 0;
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => run(() => (this.#generations.get(threadId) ?? 0) === generation));

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
