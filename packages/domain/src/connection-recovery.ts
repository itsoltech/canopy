export type RecoveryStatus = "live" | "reconnecting" | "unavailable";

export interface RecoverySnapshot {
  status: RecoveryStatus;
  retrying: boolean;
  retryAt: number | undefined;
}

export const UNAVAILABLE_AFTER_MS = 12_000;
const UNAVAILABLE_FAILURES = 3;

/** Downward jitter avoids synchronized retries without exceeding the 30 s cap. */
export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + 0.2 * random));
}

/**
 * Presentation and attempt activity are independent. Only a successful connection clears unavailable;
 * retry, foreground and network changes reset the backoff, never that decision.
 */
export class ConnectionRecovery {
  #status: RecoveryStatus = "reconnecting";
  #downSince: number | undefined;
  #failures = 0;
  #attempt = 0;
  #retrying = false;
  #retryAt: number | undefined;

  get snapshot(): RecoverySnapshot {
    return { status: this.#status, retrying: this.#retrying, retryAt: this.#retryAt };
  }

  get unavailableAt() {
    return this.#downSince === undefined ? undefined : this.#downSince + UNAVAILABLE_AFTER_MS;
  }

  check(now = Date.now()) {
    if (this.unavailableAt !== undefined && now >= this.unavailableAt) this.#status = "unavailable";

    return this.snapshot;
  }

  begin(now = Date.now()) {
    this.#downSince ??= now;

    if (this.#status === "live") this.#status = "reconnecting";
    this.#retrying = true;
    this.#retryAt = undefined;

    return this.check(now);
  }

  failed(now = Date.now(), random = Math.random()) {
    this.#downSince ??= now;
    this.#failures++;

    if (this.#failures >= UNAVAILABLE_FAILURES) this.#status = "unavailable";
    else if (this.#status === "live") this.#status = "reconnecting";
    this.#retrying = false;
    this.#retryAt = now + retryDelay(this.#attempt++, random);

    return this.check(now);
  }

  succeeded() {
    this.#status = "live";
    this.#downSince = undefined;
    this.#failures = 0;
    this.resetBackoff();

    return this.snapshot;
  }

  resetBackoff() {
    this.#attempt = 0;
    this.#retryAt = undefined;
    this.#retrying = false;
  }
}
