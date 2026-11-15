const FIRST_MS = 60_000;
const MAX_MS = 300_000;

/**
 * Pause between diagnostics submissions after the gateway answers with a resource limit (HTTP 429 or
 * `ResourceExhausted`): 60 s, then doubling up to five minutes. The refused batch is dropped, nothing is queued,
 * and one accepted submission ends the cooldown.
 */
export class SubmitCooldown {
  #failures = 0;
  #until = 0;

  ready(now = performance.now()) {
    return now >= this.#until;
  }

  /** The gateway refused a batch for its limits. */
  limited(now = performance.now()) {
    this.#until = now + Math.min(MAX_MS, FIRST_MS * 2 ** this.#failures);
    this.#failures++;
  }

  succeeded() {
    this.#failures = 0;
    this.#until = 0;
  }
}
