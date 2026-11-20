import type { Snippet } from "svelte";
import type { FeedScrollMemory } from "./feed-scroll-memory.svelte.ts";
import type { FooterFold } from "./footer-reserve.ts";
import type { ReaderScroll } from "./scroll.ts";
import type { SizeIndex } from "./size-index.ts";
import type { FeedViewport } from "./viewport.ts";

export interface VirtualFeedProps<T> {
  rows: readonly T[];
  key: (row: T) => string;
  /** Rows of a group have similar heights (e.g. the row's kind): unmeasured rows take the group's average. */
  group: (row: T) => string;
  /** Height of a group before any of its rows was measured, in px. */
  estimate: (group: string) => number;
  label: string;
  busy?: boolean;
  top?: Snippet;
  /** In place of the rows while there are none (loading). */
  placeholder?: Snippet;
  row: Snippet<[T, number]>;
  footer?: Snippet;
  /** A status control above the footer's visible edge, beside Jump to latest when both fit. */
  footerAccessory?: Snippet;
  /** How the footer's height relates to its full height (only full-height changes move the end reserve),
   * and the end space above the full footer that absorbs one more strip without moving rows, in px. */
  footerFit?: { fold: FooterFold; margin: number };
  /** How a row inserted between shown rows enters (none by default: e.g. older history above). */
  inserted?: (row: T) => "unfold" | "reveal" | undefined;
  /** Out: the reader follows the end (the latest rows are on screen). */
  atEnd?: boolean;
  /** Reader movement and its destination, before the next frame publishes the viewport. */
  onreaderscroll?: (scroll: ReaderScroll, viewport: FeedViewport) => void;
  /** A reader's scroll came to rest (after inertia). */
  onreaderscrollend?: () => void;
  onlatest?: () => void;
  /** Measured visible rows (no overscan), published at most once per animation frame. */
  onviewport?: (viewport: FeedViewport) => void;
  scrollMemory?: FeedScrollMemory;
  /** Row heights owned by the caller (kept across remounts, e.g. per thread); the feed's own otherwise. */
  sizes?: SizeIndex;
  /** The initial data is still loading. Keep the placeholder visible and the saved anchor intact. */
  loading?: boolean;
  ready?: boolean;
  /** The initial snapshot is measured and positioned; a retained creation view can hand off now. */
  onready?: () => void;
}
