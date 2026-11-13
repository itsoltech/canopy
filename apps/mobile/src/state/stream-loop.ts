import { Code, ConnectError } from "@connectrpc/connect";
import type { ConnectionRecovery } from "@canopy/domain/connection-recovery";

/** Pure transport loop: suspension cancels work without reporting a watch failure. */
export async function runStream<T>(options: {
  signal: AbortSignal;
  started: () => void;
  recovery: ConnectionRecovery;
  start: (signal: AbortSignal) => AsyncIterable<T>;
  receive: (value: T) => void;
  failed: (error: ConnectError) => boolean;
  retryAt: () => number;
  planned: () => boolean;
  publish: () => void;
}) {
  const { signal, recovery, publish } = options;

  while (!signal.aborted) {
    recovery.begin();
    publish();
    const started = Date.now();
    options.started();

    try {
      for await (const value of options.start(signal)) {
        if (signal.aborted) return;
        options.receive(value);
      }

      if (!signal.aborted)
        throw new ConnectError("Live update stream ended", Code.Unavailable, { "canopy-stream-ended": "true" });
    } catch (error) {
      if (signal.aborted || !options.failed(ConnectError.from(error))) return;
    }

    if (signal.aborted) return;
    const { retryAt } = recovery.failed();

    const delay = options.planned()
      ? Math.max(0, 2500 - (Date.now() - started))
      : Math.max(retryAt ?? 0, options.retryAt()) - Date.now();

    publish();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };

      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
