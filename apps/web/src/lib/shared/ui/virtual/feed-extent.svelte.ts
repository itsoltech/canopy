import { FEED_END_THRESHOLD } from "./scroll.ts";

/**
 * The feed's scroll height between settles. Without overflow the end is on screen even for a reader not
 * following it. Rows that shrank until the end is on screen (a fold closed) bring that reader back to it;
 * growth never does: a fold that opens grows towards the end, and its header keeps its place.
 */
export class FeedExtent {
  overflows = $state(true);
  private height = 0;

  /** Measures the rows at a settle: whether the reader follows the end now (still, or back at it). */
  follows({ scrollTop, scrollHeight, clientHeight }: HTMLElement, following: boolean): boolean {
    const shrank = scrollHeight < this.height - 0.5;
    this.height = scrollHeight;
    this.overflows = scrollHeight - clientHeight > FEED_END_THRESHOLD;

    return following || (shrank && scrollHeight - scrollTop - clientHeight <= FEED_END_THRESHOLD);
  }

  /** Keeps a following reader at the end. */
  pin(scroller: HTMLElement, setTop: (top: number) => void) {
    const end = scroller.scrollHeight - scroller.clientHeight;

    if (Math.abs(scroller.scrollTop - end) >= 1) setTop(end);
  }
}
