import { AsyncLocalStorage } from "node:async_hooks";

export type ProcessKind = "git" | "probe" | "install" | "utility" | "harness" | "supervisor";

export type ProcessPriority = "user" | "background";

const priorityContext = new AsyncLocalStorage<ProcessPriority>();
export const currentProcessPriority = (): ProcessPriority => priorityContext.getStore() ?? "user";

export const withProcessPriority = <T>(priority: ProcessPriority, run: () => T): T =>
  priorityContext.run(priority, run);

export interface ProcessPolicy {
  kind: ProcessKind;
  priority?: ProcessPriority;
  /** Caller supplies an opaque identity. Never logged. Only read operations may share results. */
  key?: string;
  ttlMs?: number;
  maxQueueMs?: number;
}

export class ProcessBusyError extends Error {
  constructor() {
    super("Process queue is full or the request is stale; try again.");
  }
}

interface Waiting {
  policy: ProcessPolicy;
  start(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export const PROCESS_LIMITS: Readonly<Record<ProcessKind, number>> = {
  git: 4,
  probe: 2,
  install: 1,
  utility: 2,
  harness: 24,
  supervisor: 2,
};

/** One scheduler per OS process. Long-lived harnesses cannot consume the eight short-command slots. */
export class ProcessGovernor {
  readonly #running = new Map<ProcessKind, number>();
  readonly #queue: Waiting[] = [];
  readonly #flights = new Map<string, Promise<unknown>>();
  readonly #cache = new Map<string, { value: unknown; until: number; generation: number }>();
  #generation = 0;
  #lastWarning = 0;
  #started = 0;
  #joined = 0;
  #hits = 0;
  #dropped = 0;

  constructor(
    readonly limits: Readonly<Record<ProcessKind, number>> = PROCESS_LIMITS,
    readonly globalLimit = 34,
    readonly shortLimit = 8,
    readonly maxQueue = 256,
    readonly warn: (message: string) => void = console.warn,
  ) {}

  snapshot() {
    return {
      active: [...this.#running.values()].reduce((a, b) => a + b, 0),
      byKind: Object.fromEntries(this.#running),
      queued: this.#queue.length,
      started: this.#started,
      joined: this.#joined,
      cacheHits: this.#hits,
      dropped: this.#dropped,
    };
  }

  invalidate(): void {
    this.#generation++;
    this.#cache.clear();
  }

  run<T>(policy: ProcessPolicy, operation: () => Promise<T>): Promise<T> {
    policy = { ...policy, priority: policy.priority ?? currentProcessPriority() };
    const key = policy.key === undefined ? undefined : `${this.#generation}:${policy.kind}:${policy.key}`;
    const cached = key === undefined ? undefined : this.#cache.get(key);

    if (cached && cached.until > Date.now()) {
      this.#hits++;

      // SAFETY: An opaque key identifies one operation and result type, as required by ProcessPolicy.
      return Promise.resolve(cached.value as T);
    }

    const flight = key === undefined ? undefined : this.#flights.get(key);

    if (flight) {
      this.#joined++;

      if (policy.priority === "user") {
        const waiting = this.#queue.find((w) => w.policy.kind === policy.kind && w.policy.key === policy.key);

        if (waiting && waiting.policy.priority === "background") {
          waiting.policy.priority = "user";
          clearTimeout(waiting.timer);
          waiting.timer = setTimeout(() => this.#drop(waiting), policy.maxQueueMs ?? 30_000);
          this.#drain();
        }
      }

      // SAFETY: Callers use the same result type for an operation's opaque key.
      return flight as Promise<T>;
    }

    const generation = this.#generation;

    const task = this.#enqueue(policy, operation).then((value) => {
      if (key !== undefined && policy.ttlMs && generation === this.#generation) {
        if (this.#cache.size >= 512) this.#cache.delete(this.#cache.keys().next().value!);
        this.#cache.set(key, { value, until: Date.now() + policy.ttlMs, generation });
      }

      return value;
    });

    if (key !== undefined) {
      this.#flights.set(key, task);
      void task.finally(() => this.#flights.delete(key)).catch(() => {});
    }

    return task;
  }

  /** Synchronous APIs (SDK launch hooks, constructors) fail with back-pressure instead of spawning unboundedly. */
  reserve(kind: ProcessKind): () => void {
    if (!this.#available(kind)) {
      this.#saturated();
      throw new ProcessBusyError();
    }

    this.#started++;
    this.#running.set(kind, (this.#running.get(kind) ?? 0) + 1);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.#running.set(kind, (this.#running.get(kind) ?? 1) - 1);
      this.#drain();
    };
  }

  #available(kind: ProcessKind): boolean {
    const { active } = this.snapshot();
    const short = ["git", "probe", "install", "utility"] as const;
    const shortActive = short.reduce((total, k) => total + (this.#running.get(k) ?? 0), 0);

    return (
      active < this.globalLimit &&
      (this.#running.get(kind) ?? 0) < this.limits[kind] &&
      (kind === "harness" || kind === "supervisor" || shortActive < this.shortLimit)
    );
  }

  #enqueue<T>(policy: ProcessPolicy, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        const release = this.reserve(policy.kind);
        void Promise.resolve().then(operation).then(resolve, reject).finally(release);
      };

      if (this.#available(policy.kind) && this.#queue.length === 0) {
        start();

        return;
      }

      this.#saturated();

      if (this.#queue.length >= this.maxQueue) {
        // Leave room for a click when background refreshes have filled the queue.
        const stale = this.#queue.findIndex((w) => w.policy.priority === "background");

        if (policy.priority !== "background" && stale >= 0) this.#drop(this.#queue[stale]!);
        else {
          this.#dropped++;
          reject(new ProcessBusyError());

          return;
        }
      }

      const wait: Waiting = {
        policy,
        start,
        reject,
        timer: setTimeout(
          () => this.#drop(wait),
          policy.maxQueueMs ?? (policy.priority === "background" ? 5_000 : 30_000),
        ),
      };

      this.#queue.push(wait);
      this.#drain();
    });
  }

  #drop(wait: Waiting): void {
    const index = this.#queue.indexOf(wait);

    if (index < 0) return;
    this.#queue.splice(index, 1);
    clearTimeout(wait.timer);
    this.#dropped++;
    wait.reject(new ProcessBusyError());
  }

  #drain(): void {
    for (;;) {
      const eligible = (w: Waiting) => this.#available(w.policy.kind);
      let index = this.#queue.findIndex((w) => w.policy.priority !== "background" && eligible(w));

      if (index < 0) index = this.#queue.findIndex(eligible);

      if (index < 0) return;
      const wait = this.#queue.splice(index, 1)[0]!;
      clearTimeout(wait.timer);
      wait.start();
    }
  }

  #saturated(): void {
    if (Date.now() - this.#lastWarning < 30_000) return;
    this.#lastWarning = Date.now();
    const { active, queued, dropped } = this.snapshot();
    this.warn(`process governor saturated: active=${active} queued=${queued} dropped=${dropped}`);
  }
}

export const processGovernor = new ProcessGovernor();
