import type { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";

/**
 * In-process fan-out of live changes to UI subscribers (one gateway instance).
 * With several instances this becomes LISTEN/NOTIFY (docs/durability.md, 4.3); the API stays the same.
 */
export class Hub {
  constructor(readonly defer?: (action: () => void) => boolean) {}
  readonly #threads = new Map<string, Set<AsyncChannel<ui.ThreadUpdate>>>();
  readonly #overview = new Set<AsyncChannel<ui.OverviewUpdate>>();

  subscribeThread(threadId: string) {
    const channel = new AsyncChannel<ui.ThreadUpdate>();
    const set = this.#threads.get(threadId) ?? new Set();
    set.add(channel);
    this.#threads.set(threadId, set);

    return {
      updates: channel,
      close: () => {
        channel.close();

        // Abort and generator cleanup can both close this subscription. An old set must never
        // remove the replacement set created by a reconnect between those two calls.
        if (set.delete(channel) && set.size === 0 && this.#threads.get(threadId) === set)
          this.#threads.delete(threadId);
      },
    };
  }

  subscribeOverview() {
    const channel = new AsyncChannel<ui.OverviewUpdate>();
    this.#overview.add(channel);

    return {
      updates: channel,
      close: () => {
        channel.close();
        this.#overview.delete(channel);
      },
    };
  }

  publishThread(threadId: string, update: ui.ThreadUpdate): void {
    if (this.defer?.(() => this.publishThread(threadId, update))) return;

    for (const channel of this.#threads.get(threadId) ?? []) channel.push(update);
  }

  publishOverview(update: ui.OverviewUpdate): void {
    if (this.defer?.(() => this.publishOverview(update))) return;

    for (const channel of this.#overview) channel.push(update);
  }
}
