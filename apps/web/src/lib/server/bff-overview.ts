import { clone, create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { BffOverviewState } from "./bff-overview-state.ts";

const MAX_HEADS = 32;
const MAX_SUBSCRIBERS = 32;
const MAX_QUEUE_ITEMS = 128;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_ITEMS = 64;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_UPDATE_BYTES = 1024 * 1024;
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 10_000;

type Gateway = Client<typeof ui.GatewayService>;

type Listener = (update: ui.OverviewUpdate) => void;

type QueuedUpdate = { epoch: number; update: ui.OverviewUpdate };

interface Subscriber {
  readonly heads: readonly string[];
  readonly queue: AsyncChannel<QueuedUpdate>;
  readonly close: () => void;
}

/**
 * One owner-scoped WatchOverview materialization for all BFF readers in a process.
 * The gateway client already carries the owner's authenticated scope; this class never accepts an owner id from a
 * request and never combines state from two gateway targets. A target change must close this instance before the
 * next one is created.
 */
export class BffOverview {
  readonly #api: Gateway;
  readonly #listeners = new Set<Listener>();
  readonly #subscribers = new Set<Subscriber>();
  readonly #state = new BffOverviewState();
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (cause: unknown) => void;
  #run: Promise<void> | undefined;
  #upstream: AbortController | undefined;
  #retryWake: AbortController | undefined;
  #retryMs = RETRY_MIN_MS;
  #revision = 0;
  #closed = false;
  #epoch = 0;
  #headRotation = 0;
  #requestedHeads = "";
  #restartRequested = false;
  #pending: { update: ui.OverviewUpdate; bytes: number }[] = [];
  #pendingBytes = 0;

  constructor(api: Gateway) {
    this.#api = api;
    this.#ready = this.#newReady();
  }

  /** Gaps requiring browser read-model invalidation; head-selection changes keep the same revision. */
  get revision(): number {
    return this.#revision;
  }

  async overview(): Promise<ui.GetOverviewResponse> {
    await this.#readyState();

    return this.#state.overview();
  }

  async threads(projectId = ""): Promise<ui.ListThreadsResponse> {
    await this.#readyState();

    return this.#state.threads(projectId);
  }

  async thread(id: string): Promise<ui.Thread | undefined> {
    await this.#readyState();

    return this.#state.thread(id);
  }

  async settings(): Promise<ui.GetSettingsResponse> {
    await this.#readyState();

    return this.#state.settings();
  }

  /** A browser subscription gets the current materialized snapshot before live changes. */
  subscribe(headIds: readonly string[], signal: AbortSignal): AsyncIterable<ui.OverviewUpdate> {
    const heads = [...new Set(headIds)];

    if (heads.length > MAX_HEADS) throw new RangeError(`At most ${MAX_HEADS} thread IDs are allowed`);

    if (this.#subscribers.size >= MAX_SUBSCRIBERS) throw new Error("Too many BFF overview subscribers");

    const queue = new AsyncChannel<QueuedUpdate>({
      maxItems: MAX_QUEUE_ITEMS,
      maxBytes: MAX_QUEUE_BYTES,
      sizeOf: (value) => this.#updateBytes(value.update),
      overflow: () => new Error("BFF overview subscriber fell behind; reconnect for a snapshot"),
    });

    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", release);
      queue.close();
      this.#subscribers.delete(subscriber);
      this.#headsChanged();
    };

    const subscriber: Subscriber = { heads, queue, close: release };

    if (this.#closed) {
      queue.close();

      return { async *[Symbol.asyncIterator]() {} };
    }

    if (signal.aborted) {
      release();

      return { async *[Symbol.asyncIterator]() {} };
    }

    this.#subscribers.add(subscriber);
    signal.addEventListener("abort", release, { once: true });
    this.#replay(queue);

    if (queue.closed) release();
    this.#headsChanged();
    this.#start();

    const active = () => !this.#closed && !signal.aborted;
    const epoch = () => this.#epoch;

    return (async function* () {
      try {
        for await (const entry of queue) {
          if (!active()) return;

          if (entry.epoch === epoch()) yield entry.update;
        }
      } finally {
        release();
      }
    })();
  }

  listen(listener: Listener): () => void {
    if (this.#closed) return () => {};

    this.#listeners.add(listener);
    this.#start();

    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch++;
    this.#upstream?.abort();
    this.#retryWake?.abort();
    this.#upstream = undefined;
    this.#retryWake = undefined;
    this.#rejectReady(new Error("BFF overview is closed"));
    this.#listeners.clear();

    for (const subscriber of this.#subscribers) subscriber.close();

    this.#subscribers.clear();
    this.#state.reset();
  }

  async #readyState(): Promise<void> {
    if (this.#closed) throw new Error("BFF overview is closed");
    this.#start();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectError("Gateway overview unavailable", Code.Unavailable)), 10_000);
    });

    try {
      for (;;) {
        const ready = this.#ready;
        await Promise.race([ready, timeout]);

        if (this.#closed) throw new Error("BFF overview is closed");

        if (this.#state.hasSnapshot && ready === this.#ready) return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #start(): void {
    if (this.#run || this.#closed) return;
    this.#run = this.#watch().finally(() => {
      this.#run = undefined;
    });
  }

  async #watch(): Promise<void> {
    while (!this.#closed) {
      const epoch = ++this.#epoch;
      const upstream = new AbortController();
      this.#upstream = upstream;
      this.#restartRequested = false;
      this.#beginEpoch();

      try {
        const request = create(ui.WatchOverviewRequestSchema, {
          includeSnapshot: true,
          threadHeadIds: this.#selectedHeads(),
        });

        this.#headRotation += this.#allHeads().length > MAX_HEADS ? MAX_HEADS : 0;

        for await (const update of this.#api.watchOverview(request, { signal: upstream.signal, timeoutMs: 0 })) {
          if (this.#closed || upstream.signal.aborted || epoch !== this.#epoch || this.#upstream !== upstream) break;
          const next = await this.#completeSnapshotSettings(update, upstream.signal, epoch);

          if (!next) break;
          this.#receive(next, epoch);
        }

        this.#retryMs = RETRY_MIN_MS;
      } catch {
        // A dropped stream gets a fresh snapshot. The current process cache is cleared at the epoch boundary.
      } finally {
        if (this.#upstream === upstream) this.#upstream = undefined;
      }

      if (this.#closed) return;

      if (!this.#restartRequested) {
        this.#revision++;

        for (const subscriber of this.#subscribers) subscriber.close();
        this.#restartRequested = false;
      }

      this.#epoch++;
      this.#beginEpoch();

      if (this.#restartRequested) continue;
      await this.#waitRetry(this.#retryMs);

      if (this.#restartRequested) continue;
      this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
    }
  }

  #beginEpoch(): void {
    const hadSnapshot = this.#state.hasSnapshot;
    this.#state.reset();
    this.#pending = [];
    this.#pendingBytes = 0;

    if (hadSnapshot) this.#ready = this.#newReady();
  }

  async #completeSnapshotSettings(
    update: ui.OverviewUpdate,
    signal: AbortSignal,
    epoch: number,
  ): Promise<ui.OverviewUpdate | undefined> {
    if (update.change.case !== "mobileSnapshot" || update.change.value.settings) return update;

    const settings = await this.#api.getSettings({}, { signal, timeoutMs: 3000 });

    if (this.#closed || signal.aborted || epoch !== this.#epoch || this.#upstream?.signal !== signal) return undefined;
    const completed = clone(ui.OverviewUpdateSchema, update);

    if (completed.change.case === "mobileSnapshot") completed.change.value.settings = settings;

    return completed;
  }

  #newReady(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    ready.catch(() => {});

    return ready;
  }

  #receive(update: ui.OverviewUpdate, epoch: number): void {
    if (update.change.case === "mobileRoutes") return;

    if (epoch !== this.#epoch || !update.change.case) throw new Error("Invalid BFF overview update");
    const bytes = this.#updateBytes(update);

    if (bytes > MAX_UPDATE_BYTES) throw new Error("BFF overview update is too large");

    if (!this.#state.hasSnapshot && update.change.case !== "mobileSnapshot") {
      if (this.#pending.length >= MAX_BUFFER_ITEMS || this.#pendingBytes + bytes > MAX_BUFFER_BYTES)
        throw new Error("BFF overview snapshot buffer overflow");

      this.#pending.push({ update: clone(ui.OverviewUpdateSchema, update), bytes });
      this.#pendingBytes += bytes;

      return;
    }

    this.#apply(update);

    if (update.change.case !== "mobileSnapshot" || !this.#state.hasSnapshot) return;

    const buffered = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;

    for (const entry of buffered) this.#apply(entry.update);
  }

  #apply(update: ui.OverviewUpdate): void {
    const wasSnapshot = this.#state.hasSnapshot;
    this.#state.apply(update);

    if (!wasSnapshot && this.#state.hasSnapshot) this.#resolveReady();
    this.#emit(update);

    if (update.change.case === "linkedReadCompleted" && ["GetOverview", "ListThreads"].includes(update.change.value)) {
      this.#restartRequested = true;
      this.#upstream?.abort();
    }
  }

  #emit(update: ui.OverviewUpdate): void {
    const value = clone(ui.OverviewUpdateSchema, update);

    for (const listener of this.#listeners) {
      try {
        listener(clone(ui.OverviewUpdateSchema, value));
      } catch {
        // A BFF consumer cannot be allowed to terminate the owner-scoped gateway stream.
      }
    }

    for (const subscriber of this.#subscribers)
      if (!subscriber.queue.push({ epoch: this.#epoch, update: clone(ui.OverviewUpdateSchema, value) }))
        subscriber.close();
  }

  #replay(queue: AsyncChannel<QueuedUpdate>): void {
    if (!this.#state.hasSnapshot) return;
    queue.push({ epoch: this.#epoch, update: this.#state.snapshotUpdate() });

    if (this.#state.feeds)
      queue.push({
        epoch: this.#epoch,
        update: create(ui.OverviewUpdateSchema, {
          change: { case: "feeds", value: this.#state.feeds },
        }),
      });
  }

  #headsChanged(): void {
    const key = this.#allHeads().join(",");

    if (key === this.#requestedHeads) return;
    this.#requestedHeads = key;
    this.#restartRequested = true;
    this.#upstream?.abort();
    this.#retryWake?.abort();
  }

  #selectedHeads(): string[] {
    const ids = this.#allHeads();

    if (ids.length <= MAX_HEADS) return ids;
    const start = this.#headRotation % ids.length;

    return Array.from({ length: MAX_HEADS }, (_, index) => ids[(start + index) % ids.length]!);
  }

  #allHeads(): string[] {
    return [...new Set([...this.#subscribers].flatMap((subscriber) => subscriber.heads))].sort();
  }

  async #waitRetry(delay: number): Promise<void> {
    const wake = new AbortController();
    this.#retryWake = wake;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    if (this.#retryWake === wake) this.#retryWake = undefined;
  }

  #updateBytes(update: ui.OverviewUpdate): number {
    return toBinary(ui.OverviewUpdateSchema, update).length;
  }
}
