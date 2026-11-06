import { duration, smoothOut } from "../motion.ts";

/** Animate the remaining distance to the live end, including row and footer measurements.
 * Each write belongs to the feed; completion does not depend on the browser's scrollend. */
export class EndScroll {
  #frame = 0;

  get active(): boolean {
    return this.#frame !== 0;
  }

  cancel(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  start(scroller: HTMLElement, write: (top: number) => void, complete: () => void): void {
    this.cancel();
    const started = performance.now();
    const ms = duration("slow");
    let previous = 0;

    const advance = (now: number) => {
      const progress = ms > 0 ? smoothOut(Math.min(1, (now - started) / ms)) : 1;
      const fraction = (progress - previous) / (1 - previous);
      const end = scroller.scrollHeight - scroller.clientHeight;
      write(scroller.scrollTop + (end - scroller.scrollTop) * fraction);
      previous = progress;

      if (progress < 1) this.#frame = requestAnimationFrame(advance);
      else {
        this.#frame = 0;
        complete();
      }
    };

    this.#frame = requestAnimationFrame(advance);
  }
}
