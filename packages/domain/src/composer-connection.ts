export const COMPOSER_DISCONNECT_GRACE_MS = 1000;

/** Presentation has a grace period; delivery always waits for an actually synchronized watch. */
export class ComposerConnection {
  #live = false;
  #available = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners = new Set<() => void>();

  get live() {
    return this.#live;
  }

  get composerAvailable() {
    return this.#available;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = () => this.#available;

  update(live: boolean) {
    if (live === this.#live) return;
    this.#live = live;
    clearTimeout(this.#timer);

    if (live) this.#available = true;
    else
      this.#timer = setTimeout(() => {
        this.#available = false;
        this.#notify();
      }, COMPOSER_DISCONNECT_GRACE_MS);

    this.#notify();
  }

  waitUntilLive(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    if (this.#live) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };

      const abort = () => {
        cleanup();
        reject(signal.reason);
      };

      const unsubscribe = this.subscribe(() => {
        if (!this.#live) return;
        cleanup();
        resolve();
      });

      signal.addEventListener("abort", abort, { once: true });
    });
  }

  reset() {
    clearTimeout(this.#timer);
    this.#live = false;
    this.#available = false;
    this.#notify();
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}
