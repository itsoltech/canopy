/** At most one capture is in progress per group. A lease heartbeat alone should never trigger a capture. */
export class FrameDemand {
  #wake: (() => void) | undefined;

  changed(): void {
    this.#wake?.();
  }

  async wait(signal: AbortSignal, nextFrameIn: () => number): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const ms = nextFrameIn();

      if (!ms) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          this.#wake = undefined;
          resolve();
        };

        const timer = Number.isFinite(ms) ? setTimeout(wake, ms) : undefined;
        this.#wake = wake;
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
}
