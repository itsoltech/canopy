import type { ThreadEvent } from "@canopy/contracts";
import type { IngestFallback } from "../store/ingest-outcomes.ts";
import type { WorkerConnection } from "../worker-link/connection.ts";

type Persist = (events: ThreadEvent[], fallback?: IngestFallback) => Promise<string | undefined>;

const BACKOFF = [250, 1_000, 4_000];

/** Each thread has its own ordered lane. A failed write never drains unrelated running turns. */
export class WorkerIngestQueue {
  readonly #pending = new Map<string, Promise<void>>();
  readonly #stop = new AbortController();

  constructor(
    readonly connection: WorkerConnection,
    readonly persist: Persist,
  ) {
    void connection.closed.then(() => this.#stop.abort());
  }

  enqueue(event: ThreadEvent) {
    const previous = this.#pending.get(event.threadId);
    const firstFailure = Promise.withResolvers<void>();
    const next = (previous ?? Promise.resolve()).then(() => this.#store(event, firstFailure.resolve));
    this.#pending.set(event.threadId, next);
    void next.finally(() => {
      if (this.#pending.get(event.threadId) === next) this.#pending.delete(event.threadId);
    });

    // Preserve stream ordering for successful writes (e.g. turn_started before a tool call).
    // Only failed lanes yield the stream while retaining their own event order.
    return previous ? Promise.resolve() : Promise.race([next, firstFailure.promise]);
  }

  async finished() {
    this.#stop.abort();
    await Promise.all(this.#pending.values());
  }

  async #store(event: ThreadEvent, firstFailure: () => void) {
    let attempt = 0;
    let code = "58000";

    while (!this.#stop.signal.aborted) {
      const fallback: IngestFallback | undefined =
        attempt >= BACKOFF.length ? { code, reason: "retry_exhausted" } : undefined;

      try {
        const failure = await this.persist([event], fallback);

        if (!failure) return;
        code = failure;
      } catch {
        // The journal remains authoritative even if enrichment, transport or the database is unavailable.
      }

      firstFailure();
      const delay = BACKOFF[attempt] ?? 30_000;
      attempt++;
      await new Promise<void>((resolve) => {
        if (this.#stop.signal.aborted) return resolve();

        const done = () => {
          clearTimeout(timer);
          this.#stop.signal.removeEventListener("abort", done);
          resolve();
        };

        const timer = setTimeout(done, delay);
        this.#stop.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
