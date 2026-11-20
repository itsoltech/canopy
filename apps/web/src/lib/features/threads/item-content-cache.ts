import type { Item, ui } from "@canopy/contracts";
import { createSubscriber } from "svelte/reactivity";

interface Entry {
  readonly key: string;
  readonly threadId: string;
  readonly bytes: bigint;
  item?: Item;
  readonly listeners: Set<() => void>;
  readonly track: () => void;
}

/** The budget covers completed reads after their last reader leaves. Mounted answers and their actions share one item. */
export class ItemContentCache {
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<AbortController, string>();

  constructor(readonly limits = { count: 32, bytes: 8 * 1024 * 1024 }) {}

  #entry(threadId: string, reference: ui.ThreadSyncContent): Entry {
    const key = JSON.stringify([threadId, reference.sha256]);
    const existing = this.#entries.get(key);

    if (existing) return existing;

    const entry: Entry = {
      key,
      threadId,
      bytes: reference.sizeBytes,
      listeners: new Set(),
      track: createSubscriber((notify) => this.watch(threadId, reference, notify)),
    };

    this.#entries.set(key, entry);

    return entry;
  }

  watch(threadId: string, reference: ui.ThreadSyncContent, notify: () => void) {
    const entry = this.#entry(threadId, reference);
    entry.listeners.add(notify);

    return () => {
      if (entry.listeners.delete(notify)) this.#settle(entry);
    };
  }

  get(threadId: string, reference: ui.ThreadSyncContent | undefined): Item | undefined {
    if (!reference) return undefined;
    const entry = this.#entry(threadId, reference);
    entry.track();

    // An untracked lookup of a preview must not accumulate an empty slot.
    if (!entry.listeners.size && !entry.item) this.#entries.delete(entry.key);

    return entry.item;
  }

  async load(
    threadId: string,
    reference: ui.ThreadSyncContent,
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<Item>,
  ) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.#pending.set(controller, threadId);

    try {
      const item = await read(combined);
      combined.throwIfAborted();
      const entry = this.#entry(threadId, reference);
      entry.item = item;

      for (const notify of entry.listeners) notify();
      this.#settle(entry);
    } finally {
      this.#pending.delete(controller);
    }
  }

  release(threadId?: string) {
    for (const [controller, id] of this.#pending) if (threadId === undefined || id === threadId) controller.abort();

    for (const entry of this.#entries.values()) {
      if (threadId !== undefined && entry.threadId !== threadId) continue;
      delete entry.item;

      if (!entry.listeners.size) this.#entries.delete(entry.key);
      else for (const notify of entry.listeners) notify();
    }
  }

  #settle(entry: Entry) {
    if (entry.listeners.size) return;
    this.#entries.delete(entry.key);

    if (!entry.item || entry.bytes > this.limits.bytes) {
      delete entry.item;

      return;
    }

    this.#entries.set(entry.key, entry);
    let count = 0;
    let bytes = 0n;

    for (const recent of [...this.#entries.values()].reverse()) {
      if (recent.listeners.size) continue;
      bytes += recent.bytes;

      if (++count > this.limits.count || bytes > this.limits.bytes) {
        this.#entries.delete(recent.key);
        delete recent.item;
      }
    }
  }
}

export const itemContents = new ItemContentCache();
