import type { PinnedTransport } from "./routes";

export const FAST_PROBE_MS = 2000;
export const RECOVERY_PROBE_MS = 8000;

/** A route failed its TLS check; codes contain only native domains/classes, never error messages. */
export class ProbeError extends Error {
  constructor(
    readonly code: string,
    message = `Secure route unavailable (${code})`,
  ) {
    super(message);
  }
}

/** Also bounds DNS and transports that fail to settle; abort only cancels this handshake, never an RPC. */
export function probeRoute(
  transport: PinnedTransport,
  address: string,
  pin: string,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();

    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();

      if (error) reject(error);
      else resolve();
    };

    const abort = () => finish(new Error("Route check canceled"));
    const timer = setTimeout(() => finish(new ProbeError("timeout")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) {
      abort();

      return;
    }

    transport.probe(address, pin, controller.signal, timeoutMs).then(
      () => finish(),
      (error: Error) => finish(error),
    );
  });
}
