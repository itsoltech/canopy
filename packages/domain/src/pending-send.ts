/** Keep one immutable request pending until an idempotent send has a known outcome. */
export async function resolvePendingSend<A>(
  attempt: () => Promise<A | undefined>,
  options: {
    uncertain: (error: Error) => boolean;
    onWaiting?: () => void;
    signal?: AbortSignal;
    retryMs?: number;
  },
): Promise<A> {
  let waiting = false;

  while (true) {
    options.signal?.throwIfAborted();

    try {
      const result = await attempt();

      if (result !== undefined) return result;
    } catch (error) {
      if (!options.uncertain(error instanceof Error ? error : new Error("Send outcome unavailable"))) throw error;
    }

    if (!waiting) {
      waiting = true;
      options.onWaiting?.();
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => options.signal?.removeEventListener("abort", abort);

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, options.retryMs ?? 2000);

      const abort = () => {
        clearTimeout(timer);
        cleanup();
        reject(options.signal?.reason);
      };

      options.signal?.addEventListener("abort", abort, { once: true });

      if (options.signal?.aborted) abort();
    });
  }
}
