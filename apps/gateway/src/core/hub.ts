import { ui } from "@canopy/contracts";
import { toBinary } from "@bufbuild/protobuf";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { threadUpdateBytes } from "./thread-update-bytes.ts";

const limits = {
  maxItems: 256,
  maxBytes: 8 * 1024 * 1024,
  overflow: () => new ConnectError("Stream fell behind; resume from its checkpoint", Code.DataLoss),
};

/**
 * In-process fan-out of live changes to UI subscribers (one gateway instance).
 * With several instances this becomes LISTEN/NOTIFY (docs/durability.md, 4.3); the API stays the same.
 */
export class Hub {
  constructor(
    readonly defer?: (action: () => void) => boolean,
    readonly observe?: (metric: number, value: number) => void,
  ) {}
  readonly #threads = new Map<string, Set<AsyncChannel<ui.ThreadUpdate>>>();
  readonly #threadObservers = new Map<string, Set<(update: ui.ThreadUpdate) => void>>();
  readonly #overview = new Set<AsyncChannel<ui.OverviewUpdate>>();
  #peakItems = 0;
  #peakBytes = 0;
  #publications = 0;
  #attempts = 0;
  #overflows = 0;
  #peakRecipients = 0;
  #lastRecipients = 0;

  snapshot() {
    this.observe?.(31, this.#publications);
    this.observe?.(32, this.#attempts);
    this.observe?.(36, this.#overflows);

    if (this.#attempts) {
      this.observe?.(33, this.#peakRecipients);
      this.observe?.(33, this.#lastRecipients);
    }

    this.#publications = 0;
    this.#attempts = 0;
    this.#overflows = 0;
    this.#peakRecipients = 0;
    let watches = 0;
    let items = 0;
    let bytes = 0;

    for (const channels of this.#threads.values()) {
      watches += channels.size;

      for (const channel of channels) {
        items = Math.max(items, channel.queuedItems);
        bytes = Math.max(bytes, channel.queuedBytes);
      }
    }

    for (const channel of this.#overview) {
      items = Math.max(items, channel.queuedItems);
      bytes = Math.max(bytes, channel.queuedBytes);
    }

    const result = {
      threads: watches,
      overview: this.#overview.size,
      items,
      bytes,
      peakItems: Math.max(items, this.#peakItems),
      peakBytes: Math.max(bytes, this.#peakBytes),
    };

    this.#peakItems = items;
    this.#peakBytes = bytes;

    return result;
  }

  #publish<A>(channels: Set<AsyncChannel<A>>, update: A, bytes: number) {
    this.#attempts += channels.size;
    this.#lastRecipients = channels.size;
    this.#peakRecipients = Math.max(this.#peakRecipients, channels.size);

    for (const channel of channels) {
      const closed = channel.closed;

      if (!channel.push(update, bytes)) {
        channels.delete(channel);

        if (!closed) this.#overflows++;
      }

      this.#peakItems = Math.max(this.#peakItems, channel.queuedItems);
      this.#peakBytes = Math.max(this.#peakBytes, channel.queuedBytes);
    }
  }

  /** Sequence readers only need invalidation and controls, without a transcript queue or serialization. */
  observeThread(threadId: string, notify: (update: ui.ThreadUpdate) => void) {
    const observers = this.#threadObservers.get(threadId) ?? new Set();
    observers.add(notify);
    this.#threadObservers.set(threadId, observers);

    return () => {
      observers.delete(notify);

      if (!observers.size && this.#threadObservers.get(threadId) === observers) this.#threadObservers.delete(threadId);
    };
  }

  subscribeThread(threadId: string) {
    const channel = new AsyncChannel<ui.ThreadUpdate>(limits);
    const set = this.#threads.get(threadId) ?? new Set();
    set.add(channel);
    this.#threads.set(threadId, set);

    return {
      updates: channel,
      close: () => {
        channel.close();

        // Abort and generator cleanup can both close this subscription. An old set must never
        // remove the replacement set created by a reconnect between those two calls.
        set.delete(channel);

        if (set.size === 0 && this.#threads.get(threadId) === set) this.#threads.delete(threadId);
      },
    };
  }

  subscribeOverview() {
    const channel = new AsyncChannel<ui.OverviewUpdate>(limits);
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
    this.#publications++;

    for (const notify of this.#threadObservers.get(threadId) ?? []) notify(update);
    const channels = this.#threads.get(threadId);

    if (!channels?.size) return;
    const bytes = threadUpdateBytes(update).length;

    this.#publish(channels, update, bytes);

    if (!channels.size) this.#threads.delete(threadId);
  }

  publishOverview(update: ui.OverviewUpdate): void {
    if (this.defer?.(() => this.publishOverview(update))) return;
    this.#publications++;

    if (!this.#overview.size) return;
    const bytes = toBinary(ui.OverviewUpdateSchema, update).length;

    this.#publish(this.#overview, update, bytes);
  }
}
