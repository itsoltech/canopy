export interface IdleUpdateOptions {
  idle(): boolean | Promise<boolean>;
  /** Synchronous admission barrier: block new turns before inspecting active work. */
  drain(value: boolean): void;
  waiting(): Promise<void>;
  apply(): Promise<void>;
  force?: boolean;
  maxWaitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/** Reaching the max delay fails safely; only an explicit force may interrupt active turns. */
export async function whenIdle(options: IdleUpdateOptions): Promise<void> {
  options.drain(true);
  const deadline = Date.now() + (options.maxWaitMs ?? 30 * 60_000);

  try {
    if (!options.force && !(await options.idle())) await options.waiting();

    while (!options.force && !(await options.idle())) {
      options.signal?.throwIfAborted();

      if (Date.now() >= deadline)
        throw new Error(
          "Update deferred: active work did not finish before the idle deadline. Retry or explicitly force the update.",
        );
      await Bun.sleep(options.pollMs ?? 500);
    }

    options.signal?.throwIfAborted();
    await options.apply();
  } finally {
    options.drain(false);
  }
}
