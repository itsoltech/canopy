import { Journal } from "../journal/index.ts";
import type { HostState } from "./host-state.ts";

const INTERVAL_MS = 60 * 60_000;

/** Cache maintenance is independent of the gateway connection. */
export class WorkerPreviewCleanup {
  readonly #abort = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(readonly state: HostState) {}

  start(): Promise<void> {
    if (this.#abort.signal.aborted) return Promise.resolve();
    this.#timer ??= setInterval(() => void this.sweep(), INTERVAL_MS).unref();

    return this.sweep();
  }

  sweep(): Promise<void> {
    const { signal } = this.#abort;

    if (signal.aborted) return Promise.resolve();
    const { runtime, log } = this.state.options;

    return (this.#running ??= this.state.previews
      .prune((prune) => runtime.runPromise(Journal.use((journal) => journal.prunePreviews(prune))), signal)
      .catch(() => log?.("Preview cache cleanup will retry"))
      .finally(() => {
        this.#running = undefined;
      }));
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#abort.abort();
    await this.#running;
  }
}
