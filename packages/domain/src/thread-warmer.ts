import type { ui } from "@canopy/contracts";
import { applyThreadUpdate } from "./thread-snapshot.ts";
import { threadCacheCurrent, THREAD_WARM_LIMITS } from "./thread-warm-set.ts";

/** The cache owns its bounds: it gets the whole updated snapshot, including older pages a reader already loaded. */
export interface WarmThreadCache {
  peek(id: string): ui.ThreadSnapshot | undefined;
  load(id: string): Promise<ui.ThreadSnapshot | undefined>;
  save(snapshot: ui.ThreadSnapshot): void | Promise<void>;
}

/** One cancelable job, one timer, bounded heads and retry state. Visible views always own their watch. */
export class ThreadWarmer {
  #ids: readonly string[] = [];
  #heads = new Map<string, ui.ThreadSyncCursor>();
  #retry = new Map<string, number>();
  #satisfied = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #job: { id: string; abort: AbortController } | undefined;
  #nextAt = 0;
  #active = "";
  #after = "";
  #enabled = false;
  #closed = false;
  requests = 0;
  get enabled() {
    return this.#enabled;
  }

  constructor(
    readonly cache: WarmThreadCache,
    readonly read: (
      id: string,
      cursor: ui.ThreadSyncCursor | undefined,
      signal: AbortSignal,
    ) => AsyncIterable<ui.ThreadUpdate>,
    readonly options = { ...THREAD_WARM_LIMITS, requested: () => {} },
  ) {}

  select(ids: readonly string[]) {
    this.#ids = ids.slice(0, this.options.count);
    const selected = new Set(this.#ids);

    for (const id of this.#heads.keys())
      if (!selected.has(id)) {
        this.#heads.delete(id);
        this.#retry.delete(id);
        this.#satisfied.delete(id);
      }

    if (this.#job && !selected.has(this.#job.id)) this.#job.abort.abort();
    this.#schedule();
  }

  heads(heads: readonly ui.ThreadSyncCursor[]) {
    const selected = new Set(this.#ids);

    for (const head of heads) if (selected.has(head.threadId)) this.#heads.set(head.threadId, head);
    this.#schedule();
  }

  head(id: string) {
    return this.#heads.get(id);
  }

  enable(enabled: boolean) {
    if (enabled && !this.#enabled) this.#after = "";
    this.#enabled = enabled;

    if (!enabled) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#job?.abort.abort();
    } else this.#schedule();
  }

  /** Navigation cancels even an unrelated read and leaves a quiet interval for the first visible frame. */
  activate(id: string) {
    if (id === this.#active) return;
    this.#active = id;
    this.yieldToNavigation();
  }

  yieldToNavigation() {
    this.#job?.abort.abort();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#nextAt = Math.max(this.#nextAt, Date.now() + 500);
    this.#schedule();
  }

  close() {
    this.#closed = true;
    this.enable(false);
    this.#heads.clear();
    this.#retry.clear();
    this.#satisfied.clear();
  }

  #pending() {
    const start = this.#ids.indexOf(this.#after) + 1;
    const ordered = [...this.#ids.slice(start), ...this.#ids.slice(0, start)];

    return ordered.find((id) => {
      const head = this.#heads.get(id);

      if (id === this.#active || !head || (this.#retry.get(id) ?? 0) > Date.now()) return false;
      const signature = `${head.epoch}:${head.appliedSeq}`;

      return this.#satisfied.get(id) !== signature && !threadCacheCurrent(this.cache.peek(id), head);
    });
  }

  #schedule() {
    if (this.#closed || !this.#enabled || this.#job || this.#timer) return;
    const now = Date.now();
    const retry = Math.min(...[...this.#retry.values()].filter((at) => at > now));

    if (!this.#pending() && !Number.isFinite(retry)) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;

        if (this.#closed || !this.#enabled) return;
        const id = this.#pending();

        if (id) void this.#run(id);
        else this.#schedule();
      },
      Math.max(100, (this.#pending() ? this.#nextAt : retry) - now),
    );
  }

  async #run(id: string) {
    this.#after = id;
    const job = { id, abort: new AbortController() };
    this.#job = job;
    const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(8000)]);
    const head = this.#heads.get(id)!;
    const signature = `${head.epoch}:${head.appliedSeq}`;

    try {
      let snapshot = await this.cache.load(id);

      if (signal.aborted) return;

      if (!threadCacheCurrent(snapshot, head)) {
        this.#nextAt = Date.now() + this.options.intervalMs;
        this.requests++;
        this.options.requested();
        let updates = 0;

        for await (const update of this.read(id, snapshot?.syncCursor, signal)) {
          if (signal.aborted) return;

          if (update.syncStatus?.reason || ++updates > 5) throw new Error("Background thread read is unavailable");
          snapshot = applyThreadUpdate(snapshot, update);
        }
      }

      if (!signal.aborted && snapshot?.thread?.id === id && snapshot.syncCursor) {
        // A navigation/reset may replace the cache while this job awaits transport or disk.
        const current = this.cache.peek(id)?.syncCursor;

        if (current?.epoch === snapshot.syncCursor.epoch && current.appliedSeq > snapshot.syncCursor.appliedSeq) return;
        await this.cache.save(snapshot);

        if (threadCacheCurrent(snapshot, head) || !head.epoch) this.#satisfied.set(id, signature);
        this.#retry.delete(id);
      } else if (!signal.aborted) throw new Error("Background thread read returned no checkpoint");
    } catch {
      if (!job.abort.signal.aborted) this.#retry.set(id, Date.now() + this.options.retryMs);
    } finally {
      if (this.#job === job) this.#job = undefined;
      this.#schedule();
    }
  }
}
