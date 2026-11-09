import { Code, ConnectError } from "@connectrpc/connect";
import type { LinkedComputers } from "./runtime.ts";
import { PEER_WATCH_HEARTBEAT_MS, PEER_WATCH_LEGACY_PROBE_MS, PEER_WATCH_TIMEOUT_MS } from "./timing.ts";

export function watchTiming(computers: LinkedComputers) {
  return (
    computers.options.watchTiming ?? {
      heartbeatMs: PEER_WATCH_HEARTBEAT_MS,
      timeoutMs: PEER_WATCH_TIMEOUT_MS,
      legacyProbeMs: PEER_WATCH_LEGACY_PROBE_MS,
    }
  );
}

/** Abort the remote call itself, so pending next() and home subscriptions are released too. */
export class WatchLease {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(signal: AbortSignal, timeoutMs: number) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.renew(timeoutMs);
  }
  renew(timeoutMs: number) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () =>
        this.controller.abort(
          new ConnectError("Linked thread synchronization timed out", Code.DeadlineExceeded, {
            "canopy-error-scope": "computer",
          }),
        ),
      timeoutMs,
    );
    this.#timer.unref();
  }
  close() {
    clearTimeout(this.#timer);
    this.controller.abort();
  }
}
