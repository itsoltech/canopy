/** Shared by readers and footer controls; the feed resumes following within this distance. */
export const FEED_END_THRESHOLD = 8;

export interface ReaderScroll {
  distance: number;
  /** Positive towards older messages. Only reader-originated movement belongs here. */
  up: number;
}
