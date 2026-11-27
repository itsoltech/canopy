import { flushSync } from "svelte";
import { reserveHeight } from "./footer-edge.ts";

/**
 * How the footer's natural size relates to its full size: `open` is full, `folded` is a compact
 * form of it, `moving` is a morph between the two whose frames never change the reserve.
 */
export type FooterFold = "open" | "moving" | "folded";

/** The last full footer height any feed measured: a thread that opens folded starts from it. */
let lastFull = 0;

export interface FooterReserveState {
  fold: FooterFold;
  /** Space between the last row and the full footer. */
  margin: number;
  following: boolean;
  scroller: HTMLElement | undefined;
}

/**
 * The rows' end space under the overlay footer: its full height plus a margin. A compact footer or a
 * morph leaves the scroll geometry alone, so rows never move with the fold. Growth commits at once: a
 * following reader stays at the end in the same frame, any other reader keeps its scrollTop. Shrinking
 * follows the footer just as soon for a reader at the end, so no gap stays above a composer that shrank;
 * anyone else keeps it until back at the end.
 * Heights come without the footer's overlays (footer-edge.ts `reserveHeight`): a tray disclosure opens
 * over the rows and never changes the reserve.
 */
export class FooterReserve {
  #full = 0;
  #reserve = 0;
  #folded: { full: number; height: number } | undefined;
  #shrink = false;
  readonly #commit: (reserve: number) => void;

  constructor(commit: (reserve: number) => void) {
    this.#commit = commit;
  }

  get value(): number {
    return this.#reserve;
  }

  /** The footer's natural height as a full-height estimate; a folded footer adds what folding took away. */
  #fullFrom(height: number, fold: FooterFold): number | undefined {
    if (fold === "moving") return undefined;

    if (fold === "open") {
      this.#folded = undefined;
      lastFull = height;

      return height;
    }

    this.#folded ??= { full: this.#full || Math.max(lastFull, height), height };

    return this.#folded.full + height - this.#folded.height;
  }

  /** The reserve this height needs; undefined while the current one still fits. */
  #target(height: number, state: FooterReserveState): number | undefined {
    const full = this.#fullFrom(height, state.fold);

    if (full === undefined) return undefined;
    this.#full = full;
    const need = Math.ceil(full + state.margin);

    if (need > this.#reserve + 0.5) return need;
    // A following reader's end comes back down with the footer, frame by frame like growth; for anyone
    // else the extra space waits below the rows until they follow the end again.
    this.#shrink = need < this.#reserve - 0.5;

    return this.#shrink && state.following ? need : undefined;
  }

  /** A measured footer height: commits (flushed) and keeps a following reader at the end. */
  measure(height: number, state: FooterReserveState, write: (top: number) => void): void {
    const next = this.#target(height, state);

    if (next === undefined) return;
    this.#apply(next);
    flushSync(() => this.#commit(next));
    const { scroller } = state;

    if (state.following && scroller) write(scroller.scrollHeight - scroller.clientHeight);
  }

  /** A reader back at the end: release a deferred shrink (the caller then pins the end). */
  follow(margin: number): void {
    if (!this.#shrink) return;
    this.#apply(Math.ceil(this.#full + margin));
    this.#commit(this.#reserve);
  }

  #apply(reserve: number) {
    this.#reserve = reserve;
    this.#shrink = false;
  }

  /** A footer that settled (folded or opened): measures it once in the next frame. */
  settled(
    shell: HTMLElement | undefined,
    read: () => FooterReserveState,
    write: (top: number) => void,
  ): (() => void) | undefined {
    if (!shell) return undefined;

    const frame = requestAnimationFrame(() => this.measure(reserveHeight(shell), read(), write));

    return () => cancelAnimationFrame(frame);
  }

  /** The first height, committed (without a flush) before the feed's first frame. */
  start(height: number, state: FooterReserveState): void {
    const full = this.#fullFrom(height, state.fold);

    if (full === undefined) return;
    this.#full = full;
    this.#apply(Math.ceil(full + state.margin));
    this.#commit(this.#reserve);
  }
}
