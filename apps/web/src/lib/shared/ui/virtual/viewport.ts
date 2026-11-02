/** Actual on-screen rows, excluding overscan and the sticky footer. End is exclusive. */
export interface FeedViewport {
  readonly start: number;
  readonly end: number;
  readonly height: number;
}
