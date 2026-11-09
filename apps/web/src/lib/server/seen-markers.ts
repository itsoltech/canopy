/** Best-effort read markers share one in-flight RPC per thread and retain only the highest pending seq. */
export class SeenMarkers {
  readonly #pending = new Map<string, bigint>();
  readonly #active = new Map<string, bigint>();

  constructor(readonly mark: (threadId: string, seq: bigint) => Promise<void>) {}

  enqueue(threadId: string, seq: bigint): void {
    if (!this.#active.has(threadId) && this.#active.size >= 256) return;
    const current = this.#pending.get(threadId) ?? this.#active.get(threadId);

    if (current !== undefined && seq <= current) return;
    this.#pending.set(threadId, seq);

    if (this.#active.has(threadId)) return;
    this.#active.set(threadId, seq);
    void this.#drain(threadId);
  }

  async #drain(threadId: string): Promise<void> {
    try {
      while (this.#pending.has(threadId)) {
        const seq = this.#pending.get(threadId)!;
        this.#pending.delete(threadId);
        this.#active.set(threadId, seq);

        try {
          await this.mark(threadId, seq);
        } catch {
          /* The next visible result can report again. */
        }
      }
    } finally {
      this.#pending.delete(threadId);
      this.#active.delete(threadId);
    }
  }
}
