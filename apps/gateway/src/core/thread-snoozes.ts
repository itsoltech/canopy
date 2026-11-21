import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { isEntityId, splitId } from "@canopy/domain/computers";
import { coreLog, corePublishThreadHeader, coreRun } from "./core-broadcast.ts";
import { coreState, describeError, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreUiThread } from "./core-titles.ts";

function snoozeDeadline(timestamp: Timestamp): Date {
  if (
    timestamp.seconds < -62135596800n ||
    timestamp.seconds > 253402300799n ||
    !Number.isInteger(timestamp.nanos) ||
    timestamp.nanos < 0 ||
    timestamp.nanos >= 1_000_000_000
  )
    throw new InvalidError("Choose a valid snooze time.");

  return new Date(Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000));
}

/** Snooze changes metadata while the worker, queue and read cursor keep their normal lifecycle. */
export class ThreadSnoozes {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(readonly core: GatewayCore) {}

  async set(request: ui.SetThreadSnoozeRequest): Promise<ui.Thread> {
    const { threadId, snoozed, snoozedUntil } = request;

    if (!isEntityId(threadId) || splitId(threadId).node) throw new InvalidError("Choose a valid thread.");
    const until = snoozed && snoozedUntil ? snoozeDeadline(snoozedUntil) : null;

    const {
      actions,
      options: { userId },
    } = this.core[coreState];

    return this.#write(() =>
      actions.transaction(async () => {
        const changed = await coreRun(this.core, (store) => store.setThreadSnooze(userId, threadId, snoozed, until));
        const row = await coreRun(this.core, (store) => store.thread(threadId, false, true));

        if (changed) actions.defer(() => corePublishThreadHeader(this.core, coreUiThread(this.core, row)));

        return coreUiThread(this.core, row);
      }),
    );
  }

  start(): void {
    this.#timer ??= setInterval(() => this.#tick(), 1_000);
    this.#tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  #tick(): void {
    this.#running ??= this.#write(() => this.#expire())
      .catch((error) => coreLog(this.core, `Thread snooze expiry failed: ${describeError(error)}`))
      .finally(() => {
        this.#running = undefined;
      });
  }

  /** Publish each local snooze commit before the next mutation or expiration can publish. */
  #write<A>(run: () => Promise<A>): Promise<A> {
    const result = this.#writes.then(run, run);
    this.#writes = result;

    return result;
  }

  async #expire(): Promise<void> {
    const { userId } = this.core[coreState].options;
    const expired = await coreRun(this.core, (store) => store.expireThreadSnoozes(userId));

    for (const row of expired) if (!row.archived_at) corePublishThreadHeader(this.core, coreUiThread(this.core, row));
  }
}
