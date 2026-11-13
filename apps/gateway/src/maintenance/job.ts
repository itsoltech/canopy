import type { gatewayRuntime } from "../runtime.ts";
import { pruneDatabase } from "./prune.ts";
import { notifyDraftOwner } from "../drafts/events.ts";

/** The DB row schedules work across instances; the timer only wakes an idle process. */
export class DatabaseMaintenance {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(
    readonly runtime: ReturnType<typeof gatewayRuntime>,
    readonly owner: string,
  ) {}

  start() {
    this.#timer ??= setInterval(() => {
      this.#running ??= this.runtime
        .runPromise(pruneDatabase(this.owner))
        .then(
          (touched) => {
            if (touched) notifyDraftOwner(this.runtime, this.owner);
          },
          () => {
            console.warn("Database maintenance deferred; durable progress will retry");
          },
        )
        .finally(() => {
          this.#running = undefined;
        });
    }, 5_000);
    this.#timer.unref();
  }

  async stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
