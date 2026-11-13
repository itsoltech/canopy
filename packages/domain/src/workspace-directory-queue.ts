/** Two requests at a time, with bounded, cancellable waiting work. */
export class DirectoryQueue {
  #active = 0;
  #waiting: Array<() => void> = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("Directory loading was cancelled.");

    if (this.#active >= 2) {
      if (this.#waiting.length >= 64)
        throw new Error("Too many directories are loading. Collapse a directory, then retry.");
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };

        const abort = () => {
          this.#waiting = this.#waiting.filter((entry) => entry !== resume);
          reject(new Error("Directory loading was cancelled."));
        };

        signal.addEventListener("abort", abort, { once: true });
        this.#waiting.push(resume);
      });
    } else this.#active++;

    return () => {
      const next = this.#waiting.shift();

      if (next) next();
      else this.#active--;
    };
  }
}
