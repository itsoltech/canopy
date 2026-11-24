import type { ThreadEvent } from "@canopy/contracts";
import { decodeAgentBusCall } from "@canopy/domain";
import { Result } from "effect";
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

  enqueue(events: [ThreadEvent, ...ThreadEvent[]]) {
    for (const event of events) removeProjectSecretResult(event);
    const { threadId } = events[0];
    const previous = this.#pending.get(threadId);
    const firstFailure = Promise.withResolvers<void>();
    const next = (previous ?? Promise.resolve()).then(() => this.#storeBatch(events, firstFailure.resolve));
    this.#pending.set(threadId, next);
    void next.finally(() => {
      if (this.#pending.get(threadId) === next) this.#pending.delete(threadId);
    });

    // Preserve stream ordering for successful writes (e.g. turn_started before a tool call).
    // Only failed lanes yield the stream while retaining their own event order.
    return previous ? Promise.resolve() : Promise.race([next, firstFailure.promise]);
  }

  async finished() {
    this.#stop.abort();
    await Promise.all(this.#pending.values());
  }

  async #storeBatch(events: ThreadEvent[], firstFailure: () => void) {
    if (events.length > 1 && !this.#stop.signal.aborted) {
      try {
        if (!(await this.persist(events))) return;
      } catch {
        // Isolate the failed write before any event can exhaust retries and enter quarantine.
      }

      firstFailure();
    }

    for (const event of events) await this.#store(event, firstFailure);
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

/** The private reply belongs to the live tool call. Keep results out of the canonical transcript. */
function removeProjectSecretResult(event: ThreadEvent) {
  if (event.body.case !== "itemStarted" && event.body.case !== "itemCompleted") return;
  const content = event.body.value.item?.content;

  if (
    content?.case === "agentBusCall" &&
    content.value.toolName === "request_secret" &&
    isProjectSecretArgs(content.value.argumentsJson)
  ) {
    content.value.resultJson = "";
    event.rawJson = "";
  }

  if (
    content?.case === "toolCall" &&
    content.value.server === "canopy" &&
    content.value.name === "request_secret" &&
    isProjectSecretArgs(content.value.inputJson)
  ) {
    content.value.output = "";
    event.rawJson = "";
  }
}

function isProjectSecretArgs(args: string) {
  const call = decodeAgentBusCall("request_secret", args);

  return Result.isSuccess(call) && call.success.tool === "request_secret" && !!call.success.args.project_secret;
}
